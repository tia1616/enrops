// review-go: the tracked "Leave a Google review" button in a review ask.
//
// GET /review-go?a=<review_asks.id>&t=<HMAC(REVIEW_RATE_SECRET, "go:"+id)>
//   1. verify the token (constant time)
//   2. record_review_click(id): stamps the click on EVERY row of that family's
//      ask for the term (siblings in one class both count), in one statement
//   3. 302 to that org's organizations.google_review_url
//
// Public (verify_jwt = false): a parent taps it from their inbox. Nothing the
// family can do here changes what anyone is sent, except stopping the one
// reminder, which is exactly what a click should do.
//
// A BAD OR MANGLED TOKEN STILL REACHES GOOGLE. A forwarded or line-wrapped link
// should not stop an honest review; it just is not counted. The Google review
// URL is public, so redirecting to it reveals nothing. Only the click record is
// gated by the token.
//
// Multi-tenant: the ask row decides the org, and the org row decides the URL.
// No tenant URL lives in code.
//
// Known limit: some mail scanners (Outlook Safe Links, corporate gateways)
// fetch links before a person does. That would record a click and skip the
// reminder for that family. Accepted: one fewer reminder, never an extra email.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { hmacBase64Url, constantTimeEquals } from "../_shared/hmac.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("REVIEW_RATE_SECRET") ?? "";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store" } });
}
function safeHttps(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === "https:" ? p.toString() : null;
  } catch {
    return null;
  }
}

serve(async (req: Request) => {
  if (req.method !== "GET" && req.method !== "HEAD") return text("Method not allowed.", 405);
  const url = new URL(req.url);
  const askId = (url.searchParams.get("a") ?? "").trim();
  const token = (url.searchParams.get("t") ?? "").trim();
  if (!UUID_RE.test(askId)) return text("This link is incomplete. Please reply to the email instead.", 400);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let tokenOk = false;
  if (SECRET && token) {
    try {
      tokenOk = constantTimeEquals(await hmacBase64Url(SECRET, `go:${askId}`), token);
    } catch {
      tokenOk = false;
    }
  }
  if (!SECRET) console.error("[review-go] REVIEW_RATE_SECRET unset: redirecting without recording");

  // HEAD (link previewers) never records.
  if (tokenOk && req.method === "GET") {
    const { data, error } = await supabase.rpc("record_review_click", { p_ask_id: askId });
    if (!error) {
      const dest = safeHttps(data as string | null);
      if (dest) return redirect(dest);
    } else {
      console.error("[review-go] record_review_click failed:", error.message);
      // fall through: still send them to Google
    }
  }

  const { data: ask, error: askErr } = await supabase
    .from("review_asks").select("organization_id").eq("id", askId).maybeSingle();
  if (askErr || !ask) return text("We couldn't find that link. Please reply to the email instead.", 404);
  const { data: org, error: orgErr } = await supabase
    .from("organizations").select("google_review_url").eq("id", ask.organization_id).maybeSingle();
  const dest = orgErr ? null : safeHttps(org?.google_review_url);
  if (!dest) return text("This link isn't set up yet. Please reply to the email instead.", 404);
  return redirect(dest);
});
