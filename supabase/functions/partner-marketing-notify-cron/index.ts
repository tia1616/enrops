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
  return json({ ok: true, mode: "cron", groups: summary }, 200);
});

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
