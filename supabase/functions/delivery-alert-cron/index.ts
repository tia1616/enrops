// delivery-alert-cron — daily PUSH alert to operators about lifecycle emails
// that didn't reach a family.
//
// Why this exists: the welcome/reminder automations are set-and-forget, so an
// operator will NOT go hunting in the app for delivery problems. The in-app
// "Didn't send" panel + the homescreen card only help if someone looks. This
// function does the pushing: it emails the operator when a family didn't get an
// email, the way real CRMs surface delivery failures.
//
// For each org with a "needs you" failure whose last attempt was in the last
// ~25h (bad address, or a transient failure that exhausted its retries), it
// emails the org's owners+admins a short digest: who to follow up with + a link.
//
// Dedupe WITHOUT a column: the 25h window. A permanent failure stops being
// retried once it caps out, so its last_attempt_at freezes and it lands in the
// window (and alerts) roughly once. A transient failure still actively failing
// re-alerts each day until it sends, which is correct. So a given miss pings the
// operator about once, not forever.
//
// Modes:
//   cron:  POST {}                              — scan every org (nightly).
//   test:  POST { organization_id, test_to }    — scope to ONE org and send ONLY
//          to test_to (never the real admins). For staging self-tests.
//
// Multi-tenant: brand + FROM via loadOrgBrand/formatFromAddress per org (never a
// hardcoded sender); recipients are that org's own admins; links use
// PUBLIC_SITE_URL (per-environment). No tenant literals.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { loadOrgBrand, formatFromAddress, encodeDisplayName } from "../_shared/orgBrand.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PUBLIC_SITE_URL = (Deno.env.get("PUBLIC_SITE_URL") ?? "https://enrops.com").replace(/\/+$/, "");

const WINDOW_HOURS = 25;
// Mirror MAX_SEND_ATTEMPTS in lifecycle-automations-cron and
// src/lib/deliveryIssues.js (frontend). Keep the three in sync.
const MAX_SEND_ATTEMPTS = 5;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Mirror classifyFailure() in src/lib/deliveryIssues.js. A bad-address (permanent
// 4xx) failure always needs the operator; a transient failure needs them only
// once it has exhausted the retry cap. Transient-and-still-retrying is the cron's
// job, so it's NOT alerted here.
function needsAttention(row: { error_message: string | null; attempts: number | null }): { needsYou: boolean; reason: string } {
  const err = (row.error_message || "").toLowerCase();
  const badAddress = /422|invalid|not a valid|validation|no recipients|parse|domain/.test(err);
  if (badAddress) return { needsYou: true, reason: "the email address on file looks invalid" };
  if ((row.attempts ?? 0) >= MAX_SEND_ATTEMPTS) return { needsYou: true, reason: "we couldn't reach their inbox after several tries" };
  return { needsYou: false, reason: "" };
}

// context_key: camp:<csid>:parent:<pid>:student:<sid> | program:<pid>:parent:<pid>:student:<sid>[:suffix]
function parseContextKey(ck: string): { kind: "camp" | "program" | null; refId: string | null; studentId: string | null } {
  const p = (ck || "").split(":");
  if ((p[0] === "camp" || p[0] === "program") && p[2] === "parent" && p[4] === "student") {
    return { kind: p[0] as "camp" | "program", refId: p[1], studentId: p[5] };
  }
  return { kind: null, refId: null, studentId: null };
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const body = await req.json().catch(() => ({}));
  const onlyOrg = typeof body?.organization_id === "string" ? body.organization_id : null;
  const testTo = typeof body?.test_to === "string" && body.test_to.includes("@") ? body.test_to.trim() : null;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const sinceIso = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();

  let q = supabase
    .from("automation_run_recipients")
    .select("organization_id, context_key, parent_id, email, automation_id, error_message, attempts, last_attempt_at")
    .eq("status", "failed")
    .gte("last_attempt_at", sinceIso)
    .limit(1000);
  if (onlyOrg) q = q.eq("organization_id", onlyOrg);
  const { data: failed, error } = await q;
  if (error) return json({ ok: false, error: error.message }, 500);

  // Keep only "needs you" failures, grouped by org.
  const byOrg = new Map<string, any[]>();
  for (const r of (failed ?? []) as any[]) {
    if (!needsAttention(r).needsYou) continue;
    if (!byOrg.has(r.organization_id)) byOrg.set(r.organization_id, []);
    byOrg.get(r.organization_id)!.push(r);
  }

  const summary: unknown[] = [];
  for (const [orgId, rows] of byOrg) {
    try {
      summary.push(await alertOrg(supabase, orgId, rows, testTo));
    } catch (e) {
      console.error(`[delivery-alert-cron] org ${orgId} failed:`, e);
      summary.push({ org: orgId, error: (e as Error).message });
    }
  }
  return json({ ok: true, mode: testTo ? "test" : "cron", orgs: summary }, 200);
});

async function alertOrg(supabase: SupabaseClient, orgId: string, rows: any[], testTo: string | null) {
  // Recipients: the org's own operators. Test mode routes ONLY to test_to so a
  // staging run never emails a real admin (check-before-send).
  let recipients: string[];
  if (testTo) {
    recipients = [testTo];
  } else {
    const { data: members } = await supabase
      .from("org_members")
      .select("email, role")
      .eq("organization_id", orgId)
      .in("role", ["owner", "admin"]);
    recipients = [...new Set((members ?? []).map((m: any) => m.email).filter((e: any) => typeof e === "string" && e.includes("@")))];
  }
  if (recipients.length === 0) return { org: orgId, families: rows.length, skipped: "no_recipients" };

  const items = await resolveItems(supabase, orgId, rows);
  const brand = await loadOrgBrand(supabase, orgId);
  const subject = items.length === 1 ? "1 family didn't get an email" : `${items.length} families didn't get an email`;
  const { html, text } = renderEmail(brand, items);

  let sent = 0;
  for (const to of recipients) {
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from: formatFromAddress(brand),
          to,
          reply_to: brand.reply_to,
          subject,
          html,
          text,
          tags: [{ name: "type", value: "delivery_alert" }],
        }),
      });
      if (resp.ok) sent += 1;
      else console.error(`[delivery-alert-cron] send to ${to} failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    } catch (e) {
      console.error(`[delivery-alert-cron] send to ${to} threw:`, e);
    }
  }
  return { org: orgId, families: items.length, recipients: recipients.length, sent };
}

// Resolve child/program display for each failed row (family label always falls
// back to the parent email so a row is never blank).
async function resolveItems(supabase: SupabaseClient, orgId: string, rows: any[]) {
  const parsed = rows.map((r) => parseContextKey(r.context_key));
  const parentIds = [...new Set(rows.map((r) => r.parent_id).filter(Boolean))];
  const studentIds = [...new Set(parsed.map((p) => p.studentId).filter(Boolean))];
  const campIds = [...new Set(parsed.filter((p) => p.kind === "camp").map((p) => p.refId))];
  const programIds = [...new Set(parsed.filter((p) => p.kind === "program").map((p) => p.refId))];

  const [parentRes, studentRes, campRes, progRes] = await Promise.all([
    parentIds.length ? supabase.from("parents").select("id, first_name, last_name").in("id", parentIds) : Promise.resolve({ data: [] as any[] }),
    studentIds.length ? supabase.from("students").select("id, first_name").in("id", studentIds) : Promise.resolve({ data: [] as any[] }),
    campIds.length ? supabase.from("camp_sessions").select("id, curriculum_name").in("id", campIds) : Promise.resolve({ data: [] as any[] }),
    programIds.length ? supabase.from("programs").select("id, curriculum").in("id", programIds) : Promise.resolve({ data: [] as any[] }),
  ]);
  const parentById = new Map((parentRes.data ?? []).map((p: any) => [p.id, p]));
  const studentById = new Map((studentRes.data ?? []).map((s: any) => [s.id, s]));
  const campById = new Map((campRes.data ?? []).map((c: any) => [c.id, c]));
  const progById = new Map((progRes.data ?? []).map((p: any) => [p.id, p]));

  return rows.map((r, i) => {
    const pk = parsed[i];
    const parent = parentById.get(r.parent_id);
    const child = pk.studentId ? studentById.get(pk.studentId) : null;
    const program = pk.kind === "camp" ? campById.get(pk.refId)?.curriculum_name : pk.kind === "program" ? progById.get(pk.refId)?.curriculum : null;
    const parentName = parent ? `${parent.first_name || ""} ${parent.last_name || ""}`.trim() || r.email : r.email;
    return {
      family: child?.first_name ? `${child.first_name}'s family` : parentName,
      program: program || null,
      reason: needsAttention(r).reason,
    };
  });
}

function renderEmail(brand: { org_name: string; logo_url: string | null; primary_color: string; page_bg_color: string }, items: { family: string; program: string | null; reason: string }[]) {
  const link = `${PUBLIC_SITE_URL}/admin/family-comms/automations`;
  const rowsHtml = items
    .map(
      (it) =>
        `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;font-size:15px;color:#1a1a1a;"><strong>${esc(it.family)}</strong>${it.program ? ` <span style="color:#6b6b6b;">(${esc(it.program)})</span>` : ""}<br><span style="color:#6b6b6b;font-size:14px;">${esc(it.reason)}</span></td></tr>`,
    )
    .join("");
  const logo = brand.logo_url
    ? `<img src="${esc(brand.logo_url)}" alt="${esc(brand.org_name)}" style="max-height:48px;display:block;margin:0 auto 20px;" />`
    : "";
  const heading = items.length === 1 ? "A family didn't get an email" : `${items.length} families didn't get an email`;
  const html = `<!doctype html><html><body style="margin:0;background:${esc(brand.page_bg_color)};padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;">
    ${logo}
    <h1 style="font-size:20px;color:${esc(brand.primary_color)};margin:0 0 12px;">${esc(heading)}</h1>
    <p style="font-size:15px;color:#1a1a1a;line-height:1.5;margin:0 0 16px;">A welcome or reminder Enrops tried to send on your behalf couldn't reach these families. Here's who to follow up with:</p>
    <table style="width:100%;border-collapse:collapse;margin:0 0 20px;">${rowsHtml}</table>
    <a href="${esc(link)}" style="display:inline-block;background:${esc(brand.primary_color)};color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:15px;font-weight:600;">Review and follow up</a>
    <p style="font-size:13px;color:#6b6b6b;line-height:1.5;margin:20px 0 0;">Enrops keeps an eye on this for you and will let you know whenever a family misses an email.</p>
  </div></body></html>`;
  const text =
    `${heading}\n\nA welcome or reminder Enrops tried to send on your behalf couldn't reach these families:\n\n` +
    items.map((it) => `- ${it.family}${it.program ? ` (${it.program})` : ""}: ${it.reason}`).join("\n") +
    `\n\nReview and follow up: ${link}\n`;
  return { html, text };
}
