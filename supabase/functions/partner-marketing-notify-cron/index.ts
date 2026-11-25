// partner-marketing-notify-cron - flyer and social graphic emails (20261125v;
// Jessica 2026-11-25: "can enrops email providers when a partner has asked for
// media? can enrops email partners when they've been uploaded?").
//
//   ask   -> the provider's owners and admins, when a partner asks for (or
//            changes its ask for) flyers / social graphics.
//   media -> the partner's logins whose sites cover the class, when the
//            provider adds or replaces a file. A site-limited login hears only
//            about its own sites' classes.
//
// What is due, and who may be told, is decided in the database
// (partner_marketing_notices_due). A burst is ONE email: a provider+partner
// group waits until nothing in it changed for 10 minutes.
//
// CLAIM, THEN SEND (_shared/claimThenSend.ts): the claim sets the row's
// notified timestamp where it is still NULL, so an overlapping run sends
// nothing; a failed send puts NULL back so the next run tries again. A group
// with nobody to tell is marked done without sending.
//
// From enrops itself (platform brand), like the partner digest.
//
// Modes:
//   cron: POST {}                         - everything due.
//   test: POST { test_to }                - the first due group, sent ONLY to
//         test_to, nothing marked done.
//
// Not openly callable: requires MARKETING_NOTIFY_SECRET in x-cron-secret, fails closed.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { loadOrgBrand, formatFromAddress } from "../_shared/orgBrand.ts";
import { deliver } from "../_shared/claimThenSend.ts";
import { isEmailAllowed } from "../_shared/emailGuard.ts";
import { fetchWithRateLimitRetry, SINGLE_EMAIL_RETRY } from "../_shared/resendRateLimit.ts";
import { renderAsk, renderMedia, groupKey, type NoticeRow } from "./noticeEmail.ts";
import { renderWrapup, renderWrapupCopy, type WrapupRow } from "./wrapupEmail.ts";

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

type Brand = Awaited<ReturnType<typeof loadOrgBrand>>;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const secret = Deno.env.get("MARKETING_NOTIFY_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return json({ error: "unauthorized" }, 401);
  }
  const body = await req.json().catch(() => ({}));
  const testTo = typeof body?.test_to === "string" && body.test_to.includes("@") ? body.test_to.trim() : null;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // End-of-class summary test (20261125w): { wrapup_test_to, wrapup_today }
  // sends the first login's email AND the provider copy to wrapup_test_to
  // only, as if today were wrapup_today. Nothing is marked sent.
  const wrapupTestTo = typeof body?.wrapup_test_to === "string" && body.wrapup_test_to.includes("@") ? body.wrapup_test_to.trim() : null;
  if (wrapupTestTo) {
    const today = typeof body?.wrapup_today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.wrapup_today) ? body.wrapup_today : null;
    return json({ ok: true, mode: "wrapup_test", ...(await wrapupTest(supabase, wrapupTestTo, today)) }, 200);
  }
  const { data, error } = await supabase.rpc("partner_marketing_notices_due");
  if (error) return json({ ok: false, error: error.message }, 500);

  const groups = new Map<string, NoticeRow[]>();
  for (const r of (data ?? []) as NoticeRow[]) {
    const k = groupKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  const brand = await loadOrgBrand(supabase, null);
  const summary: unknown[] = [];

  if (testTo) {
    // A test sends one sample, built from the first group that has someone to tell.
    const first = [...groups.values()].find((rows) => rows.some((r) => r.to_emails?.length));
    if (first) {
      const mine = first.filter((r) => r.to_emails?.length);
      const id = await send(brand, mine, testTo);
      summary.push({ kind: first[0].kind, partner: first[0].partner_name, items: mine.length, sent: id ? 1 : 0, resend_id: id, marked: "nothing (test)" });
    }
    return json({ ok: true, mode: "test", groups: summary }, 200);
  }

  for (const [key, rows] of groups) {
    try {
      summary.push({ group: key, ...(await sendGroup(supabase, brand, rows)) });
    } catch (e) {
      console.error(`[partner-marketing-notify-cron] ${key} failed:`, e);
      summary.push({ group: key, error: (e as Error).message });
    }
  }

  // End-of-class summaries (20261125w). A failure here never undoes the flyer emails above.
  let wrapups: unknown = null;
  try {
    wrapups = await sendWrapups(supabase, brand);
  } catch (e) {
    console.error(`[partner-marketing-notify-cron] wrapups failed:`, e);
    wrapups = { error: (e as Error).message };
  }
  return json({ ok: true, mode: "cron", groups: summary, wrapups }, 200);
});

// ---------------------------------------------------------------- wrap-ups

const wrapupLedger = (supabase: SupabaseClient) => supabase.from("partner_class_wrapup_sends");

/** The provider's owners and admins (the record-expiry-cron recipient rule). */
async function providerAdmins(supabase: SupabaseClient, orgId: string): Promise<string[]> {
  const { data } = await supabase.from("org_members").select("email")
    .eq("organization_id", orgId).in("role", ["owner", "admin"]).not("accepted_at", "is", null);
  return [...new Set((data ?? []).map((m: { email: string | null }) => (m.email ?? "").trim().toLowerCase()).filter((e) => e.includes("@")))];
}

/**
 * 1) One email per PERSON at a partner (its finished classes). Claim by
 *    inserting ledger rows carrying what is sent (only rows THIS run inserted
 *    are sent); release by deleting them when the send failed.
 * 2) The provider's copies, driven by the LEDGER (partner_class_wrapup_copies_due),
 *    not by this run's memory: a copy that failed is retried next run, and a
 *    person told on a later day is named then. One copy per provider + partner
 *    per run, naming who got each class.
 */
async function sendWrapups(supabase: SupabaseClient, brand: Brand) {
  const { data, error } = await supabase.rpc("partner_class_wrapups_due", { p_today: null });
  if (error) throw new Error(`due failed: ${error.message}`);
  const byPerson = new Map<string, WrapupRow[]>();
  for (const r of (data ?? []) as WrapupRow[]) {
    if (!r.summary) continue; // this person can no longer see it
    if (!byPerson.has(r.recipient_key)) byPerson.set(r.recipient_key, []);
    byPerson.get(r.recipient_key)!.push(r);
  }

  const results: unknown[] = [];
  const replyCache = new Map<string, string | null>();
  const replyFor = async (orgId: string) => {
    if (!replyCache.has(orgId)) replyCache.set(orgId, (await loadOrgBrand(supabase, orgId)).tenant_reply_to);
    return replyCache.get(orgId)!;
  };

  for (const [key, rows] of byPerson) {
    const { data: claimed, error: cErr } = await wrapupLedger(supabase)
      .upsert(rows.map((r) => ({
        organization_id: r.organization_id, partner_id: r.partner_id, class_kind: r.class_kind, class_id: r.class_id,
        recipient_key: key, to_name: r.to_name || r.to_email, payload: r,
      })), { onConflict: "class_kind,class_id,recipient_key", ignoreDuplicates: true })
      .select("id, class_kind, class_id");
    if (cErr) { results.push({ person: key, error: `claim failed: ${cErr.message}` }); continue; }
    const mineKeys = new Set((claimed ?? []).map((c: { class_kind: string; class_id: string }) => `${c.class_kind}:${c.class_id}`));
    const mine = rows.filter((r) => mineKeys.has(`${r.class_kind}:${r.class_id}`));
    if (!mine.length) { results.push({ person: key, status: "already_claimed" }); continue; }

    const { subject, html, text } = renderWrapup(brand, mine, PUBLIC_SITE_URL);
    const id = await sendRaw(brand, mine[0].to_email, subject, html, text, await replyFor(mine[0].organization_id), "partner_class_wrapup");
    if (!id) {
      const ids = (claimed ?? []).map((c: { id: string }) => c.id);
      const { error: rErr } = await wrapupLedger(supabase).delete().in("id", ids);
      if (rErr) console.error(`[partner-marketing-notify-cron] wrapup RELEASE FAILED for ${key}: ${rErr.message}`);
      results.push({ person: key, classes: mine.length, status: "released" });
      continue;
    }
    results.push({ person: key, classes: mine.length, status: "sent" });
  }

  // The provider's copies, from the ledger.
  const { data: due, error: dErr } = await supabase.rpc("partner_class_wrapup_copies_due");
  if (dErr) { results.push({ copies: `due failed: ${dErr.message}` }); return results; }
  const byPartner = new Map<string, CopyRow[]>();
  for (const c of (due ?? []) as CopyRow[]) {
    const pk = `${c.organization_id}:${c.partner_id}`;
    if (!byPartner.has(pk)) byPartner.set(pk, []);
    byPartner.get(pk)!.push(c);
  }
  for (const [pk, copies] of byPartner) {
    const admins = await providerAdmins(supabase, copies[0].organization_id);
    if (!admins.length) { results.push({ copy: pk, status: "no owner or admin email; will retry" }); continue; }
    const { data: claimed, error: cErr } = await wrapupLedger(supabase)
      .upsert(copies.map((c) => ({ organization_id: c.organization_id, partner_id: c.partner_id, class_kind: c.class_kind, class_id: c.class_id, recipient_key: "provider" })),
        { onConflict: "class_kind,class_id,recipient_key", ignoreDuplicates: true })
      .select("id, class_kind, class_id");
    if (cErr) { results.push({ copy: pk, error: `claim failed: ${cErr.message}` }); continue; }
    const mineKeys = new Set((claimed ?? []).map((c: { class_kind: string; class_id: string }) => `${c.class_kind}:${c.class_id}`));
    const mine = copies.filter((c) => mineKeys.has(`${c.class_kind}:${c.class_id}`));
    if (!mine.length) continue;
    const { subject, html, text } = renderWrapupCopy(brand, mine.map((c) => ({ ...c.payload, told: c.told_names })), PUBLIC_SITE_URL);
    let sent = 0;
    for (const to of admins) if (await sendRaw(brand, to, subject, html, text, null, "partner_class_wrapup_copy")) sent++;
    if (sent === 0) {
      const ids = (claimed ?? []).map((c: { id: string }) => c.id);
      const { error: rErr } = await wrapupLedger(supabase).delete().in("id", ids);
      if (rErr) console.error(`[partner-marketing-notify-cron] copy RELEASE FAILED for ${pk}: ${rErr.message}`);
    }
    results.push({ copy: pk, classes: mine.length, sent });
  }
  return results;
}

interface CopyRow {
  organization_id: string;
  partner_id: string;
  class_kind: string;
  class_id: string;
  payload: WrapupRow;
  told_names: string[];
}

/** Test: the first login's email and its provider copy, both to `to`, nothing marked. */
async function wrapupTest(supabase: SupabaseClient, to: string, today: string | null) {
  const { data, error } = await supabase.rpc("partner_class_wrapups_due", { p_today: today });
  if (error) return { error: error.message };
  const rows = ((data ?? []) as WrapupRow[]).filter((r) => r.summary);
  if (!rows.length) return { sent: 0, note: "nothing due for that day" };
  const first = rows.filter((r) => r.recipient_key === rows[0].recipient_key);
  const brand = await loadOrgBrand(supabase, null);
  const a = renderWrapup(brand, first, PUBLIC_SITE_URL);
  const b = renderWrapupCopy(brand, first.map((r) => ({ ...r, told: [r.to_name || r.to_email] })), PUBLIC_SITE_URL);
  const id1 = await sendRaw(brand, to, a.subject, a.html, a.text, null, "partner_class_wrapup_test");
  const id2 = await sendRaw(brand, to, b.subject, b.html, b.text, null, "partner_class_wrapup_test");
  return { partner: first[0].partner_name, classes: first.length, would_go_to: first[0].to_email, sent: [id1, id2].filter(Boolean).length, subjects: [a.subject, b.subject] };
}

/** One email; the Resend id, or null when it failed or was held back. */
async function sendRaw(brand: Brand, to: string, subject: string, html: string, text: string, replyTo: string | null, tag: string): Promise<string | null> {
  if (!isEmailAllowed(to)) {
    console.log("[partner-marketing-notify-cron] held back by the staging allowlist");
    return null;
  }
  try {
    const { res: resp } = await fetchWithRateLimitRetry(() => fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: formatFromAddress(brand), to, reply_to: replyTo ?? brand.reply_to, subject, html, text,
        tags: [{ name: "type", value: tag }],
      }),
    }), SINGLE_EMAIL_RETRY);
    if (resp.ok) return ((await resp.json().catch(() => ({}))) as { id?: string }).id ?? "unknown";
    console.error(`[partner-marketing-notify-cron] send failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  } catch (e) {
    console.error(`[partner-marketing-notify-cron] send threw:`, e);
  }
  return null;
}

/** Claim one group's rows, email each recipient the lines that are theirs, confirm or release. */
async function sendGroup(supabase: SupabaseClient, brand: Brand, rows: NoticeRow[]) {
  const kind = rows[0].kind;
  const replyTo = kind === "media" ? (await loadOrgBrand(supabase, rows[0].organization_id)).tenant_reply_to : null;
  // Media ids go in chunks: PostgREST's .in() fails past ~100 long keys
  // (reference_postgrest_in_url_ceiling), which would fail a big group forever.
  const claim = async (all: NoticeRow[]): Promise<NoticeRow[]> => {
    const now = new Date().toISOString();
    if (kind === "media") {
      const got = new Set<string>();
      for (const part of chunks(all.map((r) => r.media_id!), 50)) {
        const { data, error } = await supabase.from("class_media")
          .update({ partner_notified_at: now })
          .in("id", part).is("partner_notified_at", null).select("id");
        if (error) throw new Error(`claim failed: ${error.message}`);
        for (const d of (data ?? []) as { id: string }[]) got.add(d.id);
      }
      return all.filter((r) => got.has(r.media_id!));
    }
    // An ask is claimed only as the version that was read: an edit made since
    // (newer updated_at) stays NULL and is announced next run.
    const mine: NoticeRow[] = [];
    for (const r of all) {
      const { data, error } = await supabase.from("partner_marketing_asks")
        .update({ provider_notified_at: now })
        .eq("partner_id", r.partner_id!).eq("item_key", r.item_key)
        .lte("updated_at", r.updated_at!).is("provider_notified_at", null).select("item_key");
      if (error) throw new Error(`claim failed: ${error.message}`);
      if ((data ?? []).length) mine.push(r);
    }
    return mine;
  };
  const release = async (mine: NoticeRow[]) => {
    const errors: string[] = [];
    if (kind === "media") {
      for (const part of chunks(mine.map((r) => r.media_id!), 50)) {
        const { error } = await supabase.from("class_media").update({ partner_notified_at: null }).in("id", part);
        if (error) errors.push(error.message);
      }
    } else {
      const { error } = await supabase.from("partner_marketing_asks").update({ provider_notified_at: null })
        .eq("partner_id", rows[0].partner_id!).in("item_key", mine.map((r) => r.item_key));
      if (error) errors.push(error.message);
    }
    if (errors.length) console.error(`[partner-marketing-notify-cron] RELEASE FAILED, these will not retry: ${errors.join("; ")}`);
  };

  // Nobody to tell (no login covers the site, class cancelled, ask turned off,
  // no owner/admin email): mark done so it is not reconsidered every run.
  const tellable = rows.filter((r) => r.to_emails?.length);
  const silent = rows.filter((r) => !r.to_emails?.length);
  if (silent.length) await claim(silent);
  if (!tellable.length) return { items: rows.length, status: "nobody_to_tell" };

  const result = await deliver<NoticeRow>(tellable, {
    claim,
    send: async (mine) => {
      // Each person gets only the lines that are theirs.
      const people = [...new Set(mine.flatMap((r) => r.to_emails))];
      let sent = 0;
      const missed: string[] = [];
      for (const to of people) {
        if (await send(brand, mine.filter((r) => r.to_emails.includes(to)), to, replyTo)) sent++;
        else missed.push(to);
      }
      // Once anyone got it the group is done (no repeat to those who did);
      // say plainly who did not, so it can be followed up by hand.
      if (sent > 0 && missed.length) {
        console.error(`[partner-marketing-notify-cron] ${groupKey(mine[0])}: NOT sent to ${missed.join(", ")}`);
      }
      return sent;
    },
    confirm: async () => {},
    release,
  });
  // `items` from deliver = the rows emailed; `silent` = marked done with nobody to tell.
  return { ...result, silent: silent.length };
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** The Resend message id, or null when the send failed or was held back. */
async function send(brand: Brand, rows: NoticeRow[], to: string, replyTo: string | null = null): Promise<string | null> {
  if (!isEmailAllowed(to)) {
    console.log("[partner-marketing-notify-cron] held back by the staging allowlist");
    return null;
  }
  const { subject, html, text } = rows[0].kind === "ask"
    ? renderAsk(brand, rows, PUBLIC_SITE_URL)
    : renderMedia(brand, rows, PUBLIC_SITE_URL);
  try {
    const { res: resp } = await fetchWithRateLimitRetry(() => fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        // A partner replying about a flyer reaches the provider's own reply
        // address when it has one; otherwise, and for every ask email, the
        // enrops inbox (a real mailbox; mail.enrops.com has no MX).
        from: formatFromAddress(brand), to, reply_to: replyTo ?? brand.reply_to, subject, html, text,
        tags: [{ name: "type", value: rows[0].kind === "ask" ? "partner_marketing_ask" : "partner_marketing_media" }],
      }),
    }), SINGLE_EMAIL_RETRY);
    if (resp.ok) return ((await resp.json().catch(() => ({}))) as { id?: string }).id ?? "unknown";
    console.error(`[partner-marketing-notify-cron] send failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  } catch (e) {
    console.error(`[partner-marketing-notify-cron] send threw:`, e);
  }
  return null;
}
