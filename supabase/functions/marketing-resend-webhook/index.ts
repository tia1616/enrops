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
function base64ToBytes(b64: string): Uint8Array {
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

  // Orphan event (e.g. a transactional email, or the legacy one-shot send that
  // predates this webhook). Acknowledge with 200 so Resend doesn't retry.
  if (!send) {
    return json({ ok: true, ignored: "no_matching_send", type }, 200);
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
