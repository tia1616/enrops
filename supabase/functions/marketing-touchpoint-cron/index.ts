// marketing-touchpoint-cron
//
// Polls marketing_campaign_touchpoints due for delivery and invokes
// marketing-touchpoint-send for each. Fires every 5 minutes via pg_cron.
//
// Safety gates:
//   - Only fires touchpoints whose parent campaign has approved_at NOT NULL.
//     This protects the ~71 stuck queued touchpoints that exist today from
//     test campaigns — they all belong to unapproved campaigns and stay queued.
//   - CAS-style status update: claims a touchpoint by transitioning queued→sending.
//     If two cron invocations race, only one wins per touchpoint.
//   - Caps work per tick (5 touchpoints) and time budget (~120s) so the function
//     stays under Supabase's 150s edge-function limit.
//
// Calls marketing-touchpoint-send via HTTP with the service-role JWT in the
// bearer header (marketing-touchpoint-send recognizes service-role and grants
// the privileged 'send' mode).

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_TOUCHPOINTS_PER_TICK = 5;
const TIME_BUDGET_MS = 120_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startedAt = Date.now();
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const results = {
    started_at: new Date(startedAt).toISOString(),
    examined: 0,
    fired: 0,
    failed: 0,
    skipped_claim_race: 0,
    durations_ms: [] as number[],
    errors: [] as string[],
  };

  // ---- Find approved campaigns first (the safety gate) ----
  const { data: approvedCampaigns, error: campErr } = await supabase
    .from("marketing_campaigns")
    .select("id, organization_id, approved_recipient_ids, name")
    .not("approved_at", "is", null)
    .eq("status", "sending");
  if (campErr) {
    return json({ error: `approved campaigns query failed: ${campErr.message}`, ...results }, 500);
  }
  if (!approvedCampaigns || approvedCampaigns.length === 0) {
    return json({ message: "no approved campaigns due", ...results });
  }

  const approvedById = new Map<string, typeof approvedCampaigns[number]>();
  for (const c of approvedCampaigns) approvedById.set(c.id, c);
  const approvedIds = [...approvedById.keys()];

  // ---- Find due touchpoints in those campaigns ----
  const nowIso = new Date().toISOString();
  const { data: due, error: dueErr } = await supabase
    .from("marketing_campaign_touchpoints")
    .select("id, campaign_id, organization_id, scheduled_at, payload")
    .in("campaign_id", approvedIds)
    .lte("scheduled_at", nowIso)
    .eq("status", "queued")
    .order("scheduled_at", { ascending: true })
    .limit(MAX_TOUCHPOINTS_PER_TICK * 2); // pull a couple extra in case we lose CAS races
  if (dueErr) {
    return json({ error: `due touchpoints query failed: ${dueErr.message}`, ...results }, 500);
  }
  if (!due || due.length === 0) {
    return json({ message: "no touchpoints due", ...results });
  }

  results.examined = due.length;

  // ---- Process each touchpoint up to caps ----
  for (const tp of due) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      results.errors.push(`time budget exhausted after ${results.fired} fired`);
      break;
    }
    if (results.fired + results.failed >= MAX_TOUCHPOINTS_PER_TICK) break;

    const tpStart = Date.now();

    // Claim the touchpoint via CAS (only proceed if status is still 'queued').
    // If another invocation already claimed it (or it changed state), skip.
    const { data: claimed } = await supabase
      .from("marketing_campaign_touchpoints")
      .update({ status: "sending", updated_at: nowIso })
      .eq("id", tp.id)
      .eq("status", "queued")
      .select("id")
      .maybeSingle();
    if (!claimed) {
      results.skipped_claim_race++;
      continue;
    }

    const campaign = approvedById.get(tp.campaign_id);
    const recipientIds = campaign?.approved_recipient_ids ?? [];
    if (recipientIds.length === 0) {
      // Approved campaign with no resolved recipients — operator approved an
      // empty audience. Mark as 'skipped' (not 'failed' — nothing went wrong,
      // there was just nobody to send to).
      await supabase
        .from("marketing_campaign_touchpoints")
        .update({ status: "skipped", updated_at: new Date().toISOString() })
        .eq("id", tp.id);
      results.errors.push(`touchpoint ${tp.id}: no approved recipients`);
      continue;
    }

    // Invoke marketing-touchpoint-send (HTTP) with service-role bearer.
    let sendResult: { ok?: boolean; sent?: number; failed?: number; error?: string };
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/marketing-touchpoint-send`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          campaign_id: tp.campaign_id,
          touchpoint_id: tp.id,
          mode: "send",
          recipient_ids: recipientIds,
        }),
      });
      sendResult = await resp.json();
      if (!resp.ok) {
        sendResult = { ok: false, error: sendResult.error || `HTTP ${resp.status}` };
      }
    } catch (e) {
      sendResult = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    // Update touchpoint status based on result.
    // - All sent successfully or all skipped via dedup → 'sent'
    // - Any failures → 'failed' (operator can investigate; cron does not retry)
    const newStatus = sendResult.ok && (sendResult.failed ?? 0) === 0 ? "sent" : "failed";
    await supabase
      .from("marketing_campaign_touchpoints")
      .update({
        status: newStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("id", tp.id);

    if (newStatus === "sent") {
      results.fired++;
    } else {
      results.failed++;
      results.errors.push(`touchpoint ${tp.id}: ${sendResult.error ?? "send returned failures"}`);
    }
    results.durations_ms.push(Date.now() - tpStart);
  }

  return json({
    message: results.fired + results.failed > 0 ? `processed ${results.fired + results.failed} touchpoints` : "no touchpoints fired",
    elapsed_ms: Date.now() - startedAt,
    ...results,
  });
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
