// marketing-resend-webhook
//
// Ingests Resend delivery events and writes them back onto marketing_sends so
// every campaign has a real open/click/bounce record in our own DB. Without
// this, opens + clicks only ever lived in the Resend dashboard — which is why
// the flash-sale retrospective was unrecoverable (2026-06-02). This is the
// write-back leg that makes a native campaign retrospective possible.
//
// Resend signs webhooks with Svix. We verify the signature over the RAW body
// before trusting anything, then match the event to a marketing_sends row by
// resend_message_id = data.email_id and advance that row's status.
//
// Status is advanced MONOTONICALLY using a rank so a late-arriving 'delivered'
// can never clobber an 'opened'/'clicked' that already landed. Opens/clicks can
// fire more than once; we only stamp opened_at/clicked_at if still null, so
// re-delivery of the same event is a no-op (idempotent by construction).
//
// Deliverability: email.bounced and email.complained also write a
// marketing_suppressions row so we stop emailing that address.
//
// IMPORTANT: deploy with verify_jwt = false — Resend does not send a Supabase
// JWT. Signature verification (below) is the auth boundary instead.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Resend → Webhooks → signing secret, of the form "whsec_<base64>".
const RESEND_WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, svix-id, svix-timestamp, svix-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Monotonic status ladder. A webhook event may only PUSH a row forward along
// this ladder, never backward. Terminal failure statuses (bounced/failed) are
// handled separately and only applied to rows that haven't already progressed
// past delivery.
const STATUS_RANK: Record<string, number> = {
  pending: 0,
  throttled: 0,
  sent: 1,
  delivered: 2,
  opened: 3,
  clicked: 4,
};

// ---- Svix signature verification ----------------------------------------
// Svix signs `${id}.${timestamp}.${rawBody}` with HMAC-SHA256, keyed by the
// base64-decoded secret (the part after the "whsec_" prefix). The
// svix-signature header is a space-separated list of `v1,<base64sig>` entries
// (a secret can be rotated, so multiple may be present). A match on ANY entry
// is a pass.
// Return type is the narrow Uint8Array<ArrayBuffer>, not the default
// Uint8Array<ArrayBufferLike>. Deno 2.7 / TS 5.9 tightened crypto.subtle's
// BufferSource to exclude SharedArrayBuffer-backed views, so the unannotated
// version no longer satisfied importKey() below and `deno check` failed on this
// file. `new Uint8Array(len)` is always ArrayBuffer-backed, so this only states
// what was already true — no runtime change.
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySvix(req: Request, rawBody: string): Promise<boolean> {
  const id = req.headers.get("svix-id");
  const timestamp = req.headers.get("svix-timestamp");
  const signatureHeader = req.headers.get("svix-signature");
  if (!id || !timestamp || !signatureHeader) return false;

  // Reject stale timestamps (>5 min skew) to blunt replay attacks.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const ageSec = Math.abs(Date.now() / 1000 - ts);
  if (ageSec > 300) return false;

  const secretB64 = RESEND_WEBHOOK_SECRET.startsWith("whsec_")
    ? RESEND_WEBHOOK_SECRET.slice("whsec_".length)
    : RESEND_WEBHOOK_SECRET;

  const key = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(secretB64),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const sigBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signedContent),
  );
  const expected = bytesToBase64(new Uint8Array(sigBytes));

  // Header looks like: "v1,g0h... v1,abc..." — compare against each entry.
  for (const part of signatureHeader.split(" ")) {
    const comma = part.indexOf(",");
    const sig = comma === -1 ? part : part.slice(comma + 1);
    if (constantTimeEq(sig, expected)) return true;
  }
  return false;
}

// ---- Suppression write (bounce / complaint) -----------------------------
async function addSuppression(
  supabase: SupabaseClient,
  organizationId: string,
  email: string,
  source: "complaint" | "manual",
  reason: string,
): Promise<void> {
  const { error } = await supabase.from("marketing_suppressions").insert({
    organization_id: organizationId,
    email,
    source,
    reason,
  });
  // uq_marketing_suppressions_org_email (org, lower(email)) — a duplicate just
  // means we already suppress this address. 23505 = unique_violation; ignore.
  if (error && error.code !== "23505") {
    console.error("suppression insert failed:", error);
  }
}

// ---- Lifecycle delivery write-back ---------------------------------------
// Lifecycle email (camp welcome, recaps, birthday, review ask) is sent by
// lifecycle-automations-cron and logged in automation_run_recipients, NOT
// marketing_sends. Before this, a Resend event for one of those sends fell
// through as "no_matching_send" and the delivery outcome was simply lost — so
// "status = sent" was the end of the story and nobody could tell a delivered
// welcome from a junked one. (2026-07-30: exactly that question, unanswerable.)
//
// Three deliberate differences from the marketing path above:
//
// 1. We write delivery_status / delivered_at / bounced_at / complained_at, and
//    never touch `status`. `status` is the SEND state machine and the cron's
//    idempotency key — 'sent' means "stop retrying this context_key". Moving it
//    to 'delivered' or 'bounced' would change which rows the cron re-sends.
//
// 2. Opens and clicks are ignored. Pixel opens are the unreliable proxy this
//    whole change exists to replace, and a service email does not need
//    engagement tracking. We record only what the receiving server did.
//
// 3. A complaint does NOT auto-suppress. On the marketing side, suppression is
//    correct. Here it would be actively harmful: the informational resolvers
//    (birthday, welcome_contact) filter marketing_suppressions too, so writing a
//    suppression row would silently stop that family's CAMP LOGISTICS email —
//    the drop-off details, the recap — because someone hit "junk" once. We
//    record the complaint and leave the decision to a human.
// How long to wait before the single re-read above. Sized against what it is
// racing: the cron's own send-then-upsert gap is one Supabase round trip (tens of
// milliseconds), so this is generous cover rather than a tuned value. Kept well
// inside any sane webhook timeout, and paid only on events headed for discard.
const UNMATCHED_RECHECK_MS = 750;

async function handleLifecycleEvent(
  supabase: SupabaseClient,
  emailId: string,
  type: string,
  data: Record<string, unknown>,
): Promise<Response> {
  // resend_message_id is not UNIQUE on this table (the unique key is
  // automation_id + context_key), and a retry overwrites the id in place. A
  // Resend id is globally unique so at most one row can hold it, but limit(1)
  // rather than maybeSingle() means an unexpected duplicate degrades to "apply
  // to one row" instead of throwing PGRST116 and 500-ing the webhook.
  const { data: rows, error: lookupErr } = await supabase
    .from("automation_run_recipients")
    .select("id, delivery_status, delivered_at, bounced_at, complained_at, bounce_detail")
    .eq("resend_message_id", emailId)
    .limit(1);

  if (lookupErr) {
    console.error("automation_run_recipients lookup failed:", lookupErr);
    return json({ error: "lookup_failed" }, 500);
  }

  // ONE delayed re-check before giving up. lifecycle-automations-cron sends
  // through Resend and only THEN upserts the row carrying resend_message_id, so
  // an event that arrives inside that gap finds nothing and — because we answer
  // 200 to stop Resend retrying — would be dropped permanently, leaving
  // delivery_status NULL forever. That is exactly the "it says sent, but did it
  // land?" blind spot this wiring exists to close, so losing an event to a race
  // defeats the feature rather than merely delaying it.
  //
  // Deliberately NOT solved by returning non-2xx to lean on Resend's retries:
  // that would also retry every GENUINELY unknown event (a transactional one-off,
  // or a send predating this wiring) on Resend's full backoff schedule, forever.
  // A single short re-read costs that latency only on events we are about to
  // discard anyway, and never on the matching path.
  let row = rows?.[0];
  if (!row) {
    await new Promise((resolve) => setTimeout(resolve, UNMATCHED_RECHECK_MS));
    const { data: recheckRows, error: recheckErr } = await supabase
      .from("automation_run_recipients")
      .select("id, delivery_status, delivered_at, bounced_at, complained_at, bounce_detail")
      .eq("resend_message_id", emailId)
      .limit(1);
    if (recheckErr) {
      // Same treatment as the first lookup: a read failure is NOT proof the send
      // is unknown, so 500 and let Resend redeliver rather than silently
      // recording nothing.
      console.error("automation_run_recipients re-check failed:", recheckErr);
      return json({ error: "lookup_failed" }, 500);
    }
    row = recheckRows?.[0];
  }

  if (!row) {
    // Genuinely unknown (a transactional one-off, or a send predating this
    // wiring). 200 so Resend stops retrying.
    return json({ ok: true, ignored: "no_matching_send", type }, 200);
  }

  const nowIso = new Date().toISOString();
  const update: Record<string, unknown> = {};

  switch (type) {
    case "email.delivered":
    // A bounce and a delivery are mutually exclusive outcomes, but an open or a
    // click is positive PROOF of delivery — so if the delivered event went
    // missing, treat them as the delivery signal rather than dropping them.
    case "email.opened":
    case "email.clicked": {
      // Never downgrade a terminal negative outcome. A late 'delivered' must not
      // erase a bounce or a complaint we already recorded.
      if (row.delivery_status === "bounced" || row.delivery_status === "complained") break;
      if (row.delivery_status !== "delivered") update.delivery_status = "delivered";
      if (!row.delivered_at) update.delivered_at = nowIso;
      break;
    }
    case "email.bounced": {
      // A complaint is the stronger signal about a real person; don't overwrite
      // it with a later bounce on the same message.
      if (row.delivery_status === "complained") break;
      const bounce = (data.bounce ?? {}) as Record<string, unknown>;
      // null (not "unknown") when THIS event carries no bounce object, so the
      // check below can tell "no reason supplied" apart from a real reason.
      const detail = bounce.type
        ? `${bounce.type}${bounce.subType ? ` (${bounce.subType})` : ""}`
        : null;
      if (row.delivery_status !== "bounced") update.delivery_status = "bounced";
      if (!row.bounced_at) update.bounced_at = nowIso;
      // Only write a reason we actually have. Webhooks are at-least-once, so a
      // redelivery (or a differently-shaped bounce event) must not overwrite a
      // recorded "Permanent (General)" with "unknown" — that reason is the whole
      // value of the row to an operator deciding what to do about the address.
      if (detail) {
        if (detail !== row.bounce_detail) update.bounce_detail = detail;
      } else if (!row.bounce_detail) {
        update.bounce_detail = "unknown";
      }
      break;
    }
    case "email.complained": {
      // Recorded, NOT suppressed — see note 3 in the header comment.
      if (row.delivery_status !== "complained") update.delivery_status = "complained";
      if (!row.complained_at) update.complained_at = nowIso;
      break;
    }
    default: {
      return json({ ok: true, ignored: "unhandled_type", type }, 200);
    }
  }

  if (Object.keys(update).length === 0) {
    return json({ ok: true, noop: true, scope: "lifecycle", type }, 200);
  }

  const { error: updateErr } = await supabase
    .from("automation_run_recipients")
    .update(update)
    .eq("id", row.id);

  if (updateErr) {
    console.error("automation_run_recipients update failed:", updateErr);
    return json({ error: "update_failed" }, 500);
  }

  return json({ ok: true, scope: "lifecycle", applied: update, type }, 200);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  // Raw body FIRST — the HMAC is computed over the exact bytes Resend sent.
  const rawBody = await req.text();

  const valid = await verifySvix(req, rawBody);
  if (!valid) {
    return json({ error: "invalid_signature" }, 401);
  }

  let event: { type?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  const type = event.type ?? "";
  const data = event.data ?? {};
  const emailId = (data.email_id ?? data.id) as string | undefined;

  // Acknowledge events we can't act on so Resend stops retrying them.
  if (!emailId) {
    return json({ ok: true, ignored: "no_email_id", type }, 200);
  }

  const supabase = adminClient();

  // Match the send row. resend_message_id is unique per send.
  const { data: send, error: sendErr } = await supabase
    .from("marketing_sends")
    .select("id, organization_id, email, status, opened_at, clicked_at")
    .eq("resend_message_id", emailId)
    .maybeSingle();

  if (sendErr) {
    console.error("marketing_sends lookup failed:", sendErr);
    return json({ error: "lookup_failed" }, 500);
  }

  // No campaign row — this may be a LIFECYCLE send (welcome, recap, birthday),
  // which lives in automation_run_recipients instead. Try there before giving up.
  if (!send) {
    return await handleLifecycleEvent(supabase, emailId, type, data);
  }

  const nowIso = new Date().toISOString();
  const currentRank = STATUS_RANK[send.status] ?? 0;
  const update: Record<string, unknown> = {};

  switch (type) {
    case "email.delivered": {
      if (currentRank < STATUS_RANK.delivered) update.status = "delivered";
      break;
    }
    case "email.opened": {
      if (currentRank < STATUS_RANK.opened) update.status = "opened";
      if (!send.opened_at) update.opened_at = nowIso;
      break;
    }
    case "email.clicked": {
      if (currentRank < STATUS_RANK.clicked) update.status = "clicked";
      if (!send.clicked_at) update.clicked_at = nowIso;
      // A click implies an open even if the open event never arrived.
      if (!send.opened_at) update.opened_at = nowIso;
      break;
    }
    case "email.bounced": {
      // Only mark bounced if the row hasn't already progressed past delivery —
      // a hard bounce means it never landed, so open/click shouldn't exist.
      if (currentRank < STATUS_RANK.delivered) update.status = "bounced";
      const bounce = (data.bounce ?? {}) as Record<string, unknown>;
      update.error_message = `bounced: ${bounce.type ?? "unknown"}${
        bounce.subType ? ` (${bounce.subType})` : ""
      }`;
      // A bounce is a deliverability signal but NOT necessarily a permanent
      // opt-out; we record the failure on the send but do not auto-suppress
      // here (soft bounces recover). Hard-bounce suppression is a follow-up.
      break;
    }
    case "email.complained": {
      // Spam complaint = stop emailing this person. There is no 'complained'
      // status in the marketing_sends CHECK, so we record the complaint as a
      // suppression and leave the send status as-is.
      await addSuppression(
        supabase,
        send.organization_id,
        send.email,
        "complaint",
        `resend complaint on ${emailId}`,
      );
      return json({ ok: true, action: "suppressed", type }, 200);
    }
    default: {
      // email.sent, email.delivery_delayed, email.scheduled, etc. — nothing to
      // record beyond what the send pipeline already wrote. Acknowledge.
      return json({ ok: true, ignored: "unhandled_type", type }, 200);
    }
  }

  if (Object.keys(update).length === 0) {
    // Event was valid but added no new information (e.g. duplicate open).
    return json({ ok: true, noop: true, type }, 200);
  }

  const { error: updateErr } = await supabase
    .from("marketing_sends")
    .update(update)
    .eq("id", send.id);

  if (updateErr) {
    console.error("marketing_sends update failed:", updateErr);
    return json({ error: "update_failed" }, 500);
  }

  return json({ ok: true, applied: update, type }, 200);
});
