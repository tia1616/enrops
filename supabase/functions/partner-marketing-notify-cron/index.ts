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
  const claim = async (all: NoticeRow[]): Promise<NoticeRow[]> => {
    if (kind === "media") {
      const { data, error } = await supabase.from("class_media")
        .update({ partner_notified_at: new Date().toISOString() })
        .in("id", all.map((r) => r.media_id!)).is("partner_notified_at", null).select("id");
      if (error) throw new Error(`claim failed: ${error.message}`);
      const got = new Set((data ?? []).map((d: { id: string }) => d.id));
      return all.filter((r) => got.has(r.media_id!));
    }
    const { data, error } = await supabase.from("partner_marketing_asks")
      .update({ provider_notified_at: new Date().toISOString() })
      .eq("partner_id", rows[0].partner_id!).in("item_key", all.map((r) => r.item_key))
      .is("provider_notified_at", null).select("item_key");
    if (error) throw new Error(`claim failed: ${error.message}`);
    const got = new Set((data ?? []).map((d: { item_key: string }) => d.item_key));
    return all.filter((r) => got.has(r.item_key));
  };
  const release = async (mine: NoticeRow[]) => {
    const q = kind === "media"
      ? supabase.from("class_media").update({ partner_notified_at: null }).in("id", mine.map((r) => r.media_id!))
      : supabase.from("partner_marketing_asks").update({ provider_notified_at: null })
          .eq("partner_id", rows[0].partner_id!).in("item_key", mine.map((r) => r.item_key));
    const { error } = await q;
    if (error) console.error(`[partner-marketing-notify-cron] RELEASE FAILED, these will not retry: ${error.message}`);
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
      for (const to of people) {
        if (await send(brand, mine.filter((r) => r.to_emails.includes(to)), to, replyTo)) sent++;
      }
      return sent;
    },
    confirm: async () => {},
    release,
  });
  return { items: rows.length, ...result };
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
        // A partner replying about a flyer reaches the provider (its own
        // address only, never a platform fallback); everything else, enrops.
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
