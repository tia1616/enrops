// partner-digest-cron - the Monday digest to each partner's host admins (spec
// v3: "Your providers this week: {n} expiring, {m} expired". Nov 6 check 7).
//
// What each host admin sees is decided in the database: partner_digest_due()
// (20261102d) reads AS that host admin, through the same functions their
// portal page reads, and returns only items to report. A login with nothing to
// report gets no row and so no email.
//
// CLAIM, THEN SEND (_shared/claimThenSend.ts) over partner_digest_sends, one
// row per login per Monday: an overlapping run sends nothing, and a failed send
// releases the claim so a re-run that day tries again.
//
// From enrops itself (the platform brand), not from a provider: one digest
// covers every provider sharing with that partner.
//
// Modes:
//   cron: POST {}                                    - every partner.
//   test: POST { partner_id, test_to, today? }       - ONE partner, sent ONLY to
//         test_to, ledger untouched; `today` pretends it is that Monday.
//
// Not openly callable: requires DIGEST_SECRET in x-cron-secret, fails closed
// if unset (verify_jwt alone is satisfied by the public anon key).

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { loadOrgBrand, formatFromAddress } from "../_shared/orgBrand.ts";
import { deliver } from "../_shared/claimThenSend.ts";
import { isEmailAllowed } from "../_shared/emailGuard.ts";
import { fetchWithRateLimitRetry, SINGLE_EMAIL_RETRY } from "../_shared/resendRateLimit.ts";
import { renderDigest, type DigestRow } from "./digestEmail.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PUBLIC_SITE_URL = (Deno.env.get("PUBLIC_SITE_URL") ?? "https://enrops.com").replace(/\/+$/, "");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const secret = Deno.env.get("DIGEST_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return json({ error: "unauthorized" }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const testTo = typeof body?.test_to === "string" && body.test_to.includes("@") ? body.test_to.trim() : null;
  const onlyPartner = typeof body?.partner_id === "string" ? body.partner_id : null;
  const today = typeof body?.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : null;
  if (testTo && !onlyPartner) return json({ error: "test mode needs partner_id" }, 400);
  if (today && !testTo) return json({ error: "today is only allowed in test mode" }, 400);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase.rpc("partner_digest_due", { p_today: today });
  if (error) return json({ ok: false, error: error.message }, 500);

  // One email per host admin login.
  const byAccess = new Map<string, DigestRow[]>();
  for (const r of (data ?? []) as DigestRow[]) {
    if (onlyPartner && r.partner_id !== onlyPartner) continue;
    if (!byAccess.has(r.access_id)) byAccess.set(r.access_id, []);
    byAccess.get(r.access_id)!.push(r);
  }

  const brand = await loadOrgBrand(supabase, null);
  const summary: unknown[] = [];
  if (testTo) {
    // A test sends one sample: the first login's digest.
    const first = [...byAccess.values()][0];
    // The sender and Resend id come back so a test that never arrives can be traced.
    if (first) {
      const id = await send(brand, first, testTo);
      summary.push({ partner: first[0].partner_name, items: first.length, sent: id ? 1 : 0, from: formatFromAddress(brand), resend_id: id, ledger: "untouched (test)" });
    }
    return json({ ok: true, mode: "test", digests: summary }, 200);
  }

  for (const [accessId, rows] of byAccess) {
    try {
      summary.push({ partner: rows[0].partner_name, ...(await sendForReal(supabase, brand, accessId, rows)) });
    } catch (e) {
      console.error(`[partner-digest-cron] login ${accessId} failed:`, e);
      summary.push({ access: accessId, error: (e as Error).message });
    }
  }
  return json({ ok: true, mode: "cron", digests: summary }, 200);
});

async function sendForReal(
  supabase: SupabaseClient,
  brand: Awaited<ReturnType<typeof loadOrgBrand>>,
  accessId: string,
  rows: DigestRow[],
) {
  const weekOf = rows[0].week_of;
  const ledger = () => supabase.from("partner_digest_sends");
  let claimedId: string | null = null;
  const result = await deliver<DigestRow[]>([rows], {
    claim: async (all) => {
      const { data, error } = await ledger()
        .upsert({ access_id: accessId, week_of: weekOf, recipients: 0 }, { onConflict: "access_id,week_of", ignoreDuplicates: true })
        .select("id");
      if (error) throw new Error(`claim failed: ${error.message}`);
      claimedId = (data ?? [])[0]?.id ?? null;
      return claimedId ? all : [];
    },
    send: async ([mine]) => (await send(brand, mine, mine[0].to_email)) ? 1 : 0,
    confirm: async (_mine, sent) => {
      const { error } = await ledger().update({ recipients: sent }).eq("id", claimedId!);
      if (error) console.error(`[partner-digest-cron] login ${accessId} confirm failed (email was sent): ${error.message}`);
    },
    release: async () => {
      const { error } = await ledger().delete().eq("id", claimedId!);
      if (error) console.error(`[partner-digest-cron] login ${accessId} RELEASE FAILED, this digest will not retry: ${error.message}`);
    },
  });
  return { items: rows.length, ...result };
}

/** The Resend message id, or null when the send failed. */
async function send(brand: Awaited<ReturnType<typeof loadOrgBrand>>, rows: DigestRow[], to: string): Promise<string | null> {
  // Staging recipient guard (no-op on prod).
  if (!isEmailAllowed(to)) {
    console.log("[partner-digest-cron] held back by the staging allowlist");
    return null;
  }
  const { subject, html, text } = renderDigest(brand, rows, PUBLIC_SITE_URL);
  try {
    // A 429 is retried (Resend's limit is per ACCOUNT). Without it a collision on
    // Monday released the claim and the digest waited for a later run.
    const { res: resp } = await fetchWithRateLimitRetry(() => fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: formatFromAddress(brand), to, reply_to: brand.reply_to, subject, html, text,
        tags: [{ name: "type", value: "partner_digest" }],
      }),
    }), SINGLE_EMAIL_RETRY);
    if (resp.ok) return ((await resp.json().catch(() => ({}))) as { id?: string }).id ?? "unknown";
    console.error(`[partner-digest-cron] send failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  } catch (e) {
    console.error(`[partner-digest-cron] send threw:`, e);
  }
  return null;
}
