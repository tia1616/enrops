// record-expiry-cron - daily email to a provider's owners and admins when
// something on its safety record is about to expire or has expired (spec v3
// Nov 6: "expiry emails at 30, 14, 7 and 0 days").
//
// What is due is decided in the database: record_expiry_due() (20261102c)
// returns each document or instructor check that has entered its 30, 14, 7 or
// expiry-day window, in the provider's own timezone, and has not been emailed
// for that window. One email per provider per day lists everything due.
//
// CLAIM, THEN SEND (_shared/claimThenSend.ts). The ledger row (record_expiry_notices, unique
// per item, date and window) is written BEFORE the email, and only rows this
// run actually inserted are sent, so two overlapping runs never send the same
// notice twice. If no recipient could be emailed, or sending throws, the
// claimed rows are removed so tomorrow's run tries again.
//
// Modes (the sibling delivery-alert-cron's shape):
//   cron: POST {}                                       - every provider.
//   test: POST { organization_id, test_to, today? }     - ONE provider, sent ONLY
//         to test_to, ledger untouched; `today` (YYYY-MM-DD) pretends it is that
//         day, to check real renewal dates ahead of time.
//
// Not openly callable: requires EXPIRY_ALERT_SECRET in x-cron-secret, fails
// closed if unset (verify_jwt alone is satisfied by the public anon key).
// Multi-tenant: sender and colours from loadOrgBrand per provider; recipients
// are that provider's own owners and admins; links use PUBLIC_SITE_URL.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { loadOrgBrand, formatFromAddress } from "../_shared/orgBrand.ts";
import { renderExpiryEmail, type DueItem } from "./expiryEmail.ts";
import { deliver } from "../_shared/claimThenSend.ts";

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

  const secret = Deno.env.get("EXPIRY_ALERT_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return json({ error: "unauthorized" }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const testTo = typeof body?.test_to === "string" && body.test_to.includes("@") ? body.test_to.trim() : null;
  const onlyOrg = typeof body?.organization_id === "string" ? body.organization_id : null;
  const today = typeof body?.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : null;
  // A test needs one provider and one address; a pretend date is test-only, so
  // a real run can never mark tomorrow's notices as sent.
  if (testTo && !onlyOrg) return json({ error: "test mode needs organization_id" }, 400);
  if (today && !testTo) return json({ error: "today is only allowed in test mode" }, 400);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase.rpc("record_expiry_due", { p_today: today });
  if (error) return json({ ok: false, error: error.message }, 500);

  const byOrg = new Map<string, DueItem[]>();
  for (const it of (data ?? []) as DueItem[]) {
    if (onlyOrg && it.organization_id !== onlyOrg) continue;
    if (!byOrg.has(it.organization_id)) byOrg.set(it.organization_id, []);
    byOrg.get(it.organization_id)!.push(it);
  }

  const summary: unknown[] = [];
  for (const [orgId, items] of byOrg) {
    try {
      summary.push(testTo ? await sendTest(supabase, orgId, items, testTo) : await sendForReal(supabase, orgId, items));
    } catch (e) {
      console.error(`[record-expiry-cron] org ${orgId} failed:`, e);
      summary.push({ org: orgId, error: (e as Error).message });
    }
  }
  return json({ ok: true, mode: testTo ? "test" : "cron", orgs: summary }, 200);
});

async function sendTest(supabase: SupabaseClient, orgId: string, items: DueItem[], testTo: string) {
  const sent = await send(supabase, orgId, items, [testTo]);
  return { org: orgId, items: items.length, sent, ledger: "untouched (test)" };
}

async function sendForReal(supabase: SupabaseClient, orgId: string, items: DueItem[]) {
  const { data: members } = await supabase
    .from("org_members")
    .select("email, role")
    .eq("organization_id", orgId)
    .in("role", ["owner", "admin"]);
  const recipients = [...new Set((members ?? []).map((m: any) => m.email).filter((e: any) => typeof e === "string" && e.includes("@")))];
  if (recipients.length === 0) return { org: orgId, items: items.length, skipped: "no_recipients" };

  const key = (r: { subject_type: string; subject_id: string; expires_on: string; tier: number }) =>
    `${r.subject_type}:${r.subject_id}:${r.expires_on}:${r.tier}`;
  const idByKey = new Map<string, string>();
  const ledger = () => supabase.from("record_expiry_notices");
  const idsOf = (mine: DueItem[]) => mine.map((it) => idByKey.get(key(it))!).filter(Boolean);

  const result = await deliver<DueItem>(items, {
    // Only rows THIS run inserted come back, so an overlapping run sends nothing.
    claim: async (all) => {
      const { data, error } = await ledger()
        .upsert(all.map((it) => ({
          organization_id: orgId, subject_type: it.subject_type, subject_id: it.subject_id,
          expires_on: it.expires_on, tier: it.tier, recipients: 0,
        })), { onConflict: "subject_type,subject_id,expires_on,tier", ignoreDuplicates: true })
        .select("id, subject_type, subject_id, expires_on, tier");
      if (error) throw new Error(`claim failed: ${error.message}`);
      for (const r of (data ?? []) as any[]) idByKey.set(key(r), r.id);
      return all.filter((it) => idByKey.has(key(it)));
    },
    send: (mine) => send(supabase, orgId, mine, recipients),
    confirm: async (mine, sent) => {
      const { error } = await ledger().update({ recipients: sent }).in("id", idsOf(mine));
      if (error) console.error(`[record-expiry-cron] org ${orgId} confirm failed (emails were sent): ${error.message}`);
    },
    release: async (mine) => {
      const { error } = await ledger().delete().in("id", idsOf(mine));
      if (error) console.error(`[record-expiry-cron] org ${orgId} RELEASE FAILED, these notices will not retry: ${error.message}`);
    },
  });
  return { org: orgId, recipients: recipients.length, ...result };
}

async function send(supabase: SupabaseClient, orgId: string, items: DueItem[], recipients: string[]): Promise<number> {
  const brand = await loadOrgBrand(supabase, orgId);
  const { subject, html, text } = renderExpiryEmail(brand, items, PUBLIC_SITE_URL);
  let sent = 0;
  for (const to of recipients) {
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from: formatFromAddress(brand), to, reply_to: brand.reply_to, subject, html, text,
          tags: [{ name: "type", value: "record_expiry" }],
        }),
      });
      if (resp.ok) sent += 1;
      else console.error(`[record-expiry-cron] send to ${to} failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    } catch (e) {
      console.error(`[record-expiry-cron] send to ${to} threw:`, e);
    }
  }
  return sent;
}
