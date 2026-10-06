// Public review-rate endpoint — Phase 2 of the J2S review flow (ops manual
// section 10). Phase 1 (live) sends a star-link email whose links go
// straight to a Squarespace page with no server-side record of the tap.
// This function sits in front of that same page: record the score against
// the registration the token names, notify the operator immediately on a
// low score, then redirect — so nothing a family sees changes, but enrops
// now knows who answered what.
//
// GET /review-rate?r=<registration_id>&org=<organization_id>&t=<token>&score=1..5
//
// HMAC token is computed over `${registration_id}:${organization_id}:${score}`
// using REVIEW_RATE_SECRET — the SCORE is part of the signed message, not just
// a free query param riding alongside a token that only proves (registration,
// org). Each of the 5 star links for one registration is signed separately and
// carries a DIFFERENT token; without this, one valid link's token would
// authenticate any of the 5 scores (edit `score=` in the URL, signature still
// "verifies"), silently corrupting the average review-rate exists to protect
// and letting a family dodge or spoof the low-score operator alert below.
// Constant-time compare on verify. Not a POST + one-click design like
// unsubscribe: this is a link a family TAPS from an email, one request, no form.
//
// Multi-tenant safety: the token proves the (registration_id, organization_id)
// pair wasn't tampered with; the DB lookup below still re-confirms the
// registration actually belongs to that organization_id before writing
// anything, so a leaked/forged org id can't attribute a score to the wrong
// tenant even if the HMAC somehow validated against it.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { loadOrgBrand, formatFromAddress } from "../_shared/orgBrand.ts";
import { hmacBase64Url, constantTimeEquals } from "../_shared/hmac.ts";
import { esc as escapeHtml } from "../_shared/escapeHtml.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("REVIEW_RATE_SECRET") ?? "";
// Defaulted + checked at the low-score notification call site below, same
// fail-soft posture the rest of this function uses for RESEND_API_KEY-adjacent
// failures: a missing key must not crash the family's redirect, but it also
// must not look like a notification that actually went out.
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
// PUBLIC_SITE_URL mirrors every other sender in this repo — never hardcode
// the domain, or a staging-fired low-score alert links an operator to prod.
const PUBLIC_SITE_URL = (Deno.env.get("PUBLIC_SITE_URL") ?? "https://enrops.com").replace(/\/+$/, "");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" } });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return textResponse("Method not allowed.", 405);

  const url = new URL(req.url);
  const registrationId = (url.searchParams.get("r") ?? "").trim();
  const orgId = (url.searchParams.get("org") ?? "").trim();
  const token = (url.searchParams.get("t") ?? "").trim();
  const scoreRaw = (url.searchParams.get("score") ?? "").trim();
  const score = Number.parseInt(scoreRaw, 10);

  if (!registrationId || !orgId || !token) {
    return textResponse("This link is missing something and can't be used. Please reply to the email instead.", 400);
  }
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return textResponse("That doesn't look like a valid rating link. Please reply to the email instead.", 400);
  }
  if (!SECRET) {
    // FAIL CLOSED, same posture as marketing-touchpoint-send's unsubscribe
    // guard: with no secret, every token this function could mint or verify
    // is unsigned, and a scoring link that silently accepted anything would
    // let anyone score any registration by guessing a UUID.
    console.error("[review-rate] REVIEW_RATE_SECRET is not set — refusing");
    return textResponse("This isn't working right now. Please reply to the email instead — we'll still read it.", 503);
  }

  let signatureOk = false;
  try {
    signatureOk = await verifyToken(registrationId, orgId, score, token);
  } catch (_e) {
    signatureOk = false;
  }
  if (!signatureOk) {
    return textResponse("This rating link is invalid or has expired. Please reply to the email instead.", 401);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: reg, error: regErr } = await supabase
    .from("registrations")
    .select(`
      id, organization_id,
      students ( first_name, last_name ),
      parents ( first_name, last_name, email ),
      programs ( curriculum, program_locations ( name ) ),
      camp_sessions ( curriculum_name, location_name )
    `)
    .eq("id", registrationId)
    .maybeSingle();
  if (regErr) {
    console.error("[review-rate] registration lookup failed:", regErr.message);
    return textResponse("Something went wrong recording that. Please reply to the email instead.", 500);
  }
  // Re-confirm the org match from the ROW itself, not just the signed query
  // param — the token proves (registrationId, orgId) weren't tampered with
  // together, but the row is the only source of truth for which org this
  // registration actually belongs to.
  if (!reg || reg.organization_id !== orgId) {
    return textResponse("We couldn't find that registration. Please reply to the email instead.", 404);
  }

  const programsRow = reg.programs as { curriculum: string | null; program_locations: { name: string | null } | { name: string | null }[] | null } | null;
  const campRow = reg.camp_sessions as { curriculum_name: string | null; location_name: string | null } | null;
  const locFromPrograms = programsRow?.program_locations
    ? (Array.isArray(programsRow.program_locations) ? programsRow.program_locations[0]?.name : programsRow.program_locations.name)
    : null;
  const programName = (programsRow?.curriculum ?? campRow?.curriculum_name ?? "").trim();
  const locationName = (locFromPrograms ?? campRow?.location_name ?? "").trim();
  const student = reg.students as { first_name: string | null; last_name: string | null } | null;
  const parent = reg.parents as { first_name: string | null; last_name: string | null; email: string | null } | null;
  const childName = [student?.first_name, student?.last_name].filter(Boolean).join(" ").trim() || "their child";
  const parentName = [parent?.first_name, parent?.last_name].filter(Boolean).join(" ").trim() || "A parent";

  // ---- Record the score. One row per registration; a re-tap updates it. ----
  const { data: existing } = await supabase
    .from("program_reviews")
    .select("notified_at")
    .eq("registration_id", registrationId)
    .maybeSingle();

  const { error: upsertErr } = await supabase
    .from("program_reviews")
    .upsert(
      { organization_id: orgId, registration_id: registrationId, score, submitted_at: new Date().toISOString() },
      { onConflict: "registration_id" },
    );
  if (upsertErr) {
    console.error("[review-rate] score upsert failed:", upsertErr.message);
    return textResponse("Something went wrong recording that. Please reply to the email instead.", 500);
  }

  // ---- 1-2 stars: notify the operator right away, once. ----
  // "once" = gated on notified_at, not on this being the first tap — a family
  // that re-taps the SAME low score must not re-fire the alert, and a family
  // that taps low after an earlier low score (already notified) shouldn't
  // either; a genuinely NEW low score after a prior high one is rare enough
  // that re-notifying is the safe direction, not worth a special case.
  if (score <= 2 && !existing?.notified_at) {
    if (!RESEND_API_KEY) {
      // Loud, not silent: this is the ONE signal an operator has that the
      // alert didn't go out. notified_at is deliberately left unset — there is
      // NO automated retry today (nothing re-scans unnotified low scores), but
      // leaving it unset is still strictly better than the old unconditional
      // stamp: it's honest about what happened, and if a retry mechanism is
      // ever built, or the SAME family taps again, this row is still eligible.
      console.error("[review-rate] low-score notification skipped — RESEND_API_KEY is not set");
    } else {
      try {
        const brand = await loadOrgBrand(supabase, orgId);
        // Not a per-registration deep link — no such page exists today (ProgramRoster
        // only resolves a program_id, not a camp_session_id, and this notification
        // fires for either). /admin/rosters is the one page that's always right.
        const rosterUrl = `${PUBLIC_SITE_URL}/admin/rosters`;
        const resp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
          body: JSON.stringify({
            from: formatFromAddress(brand),
            to: brand.reply_to,
            subject: `Score ${score}: ${programName || "a review"} — follow up today`,
            html: `<p>${escapeHtml(parentName)} rated <strong>${escapeHtml(programName || "a program")}</strong>${locationName ? ` at ${escapeHtml(locationName)}` : ""} ${score} star${score === 1 ? "" : "s"}.</p>`
              + `<p>Child: ${escapeHtml(childName)}<br>Parent email: ${escapeHtml(parent?.email ?? "unknown")}</p>`
              + `<p><a href="${rosterUrl}">View the roster</a></p>`,
            text: `${parentName} rated ${programName || "a program"}${locationName ? ` at ${locationName}` : ""} ${score} star${score === 1 ? "" : "s"}.\nChild: ${childName}\nParent email: ${parent?.email ?? "unknown"}\nRoster: ${rosterUrl}`,
          }),
        });
        // fetch only rejects on a network failure — a bad/rotated API key, a
        // rate limit, or a malformed payload all resolve normally with an
        // error STATUS, which the old code never checked. Checking resp.ok
        // is what makes notified_at actually mean "the alert was sent",
        // rather than "we tried once and moved on" — the latter permanently
        // marked a failed alert as sent with no way to tell afterward. There
        // is still no automated retry (see the RESEND_API_KEY branch above);
        // this just stops the failure from being indistinguishable from
        // success in the data.
        if (resp.ok) {
          await supabase.from("program_reviews").update({ notified_at: new Date().toISOString() }).eq("registration_id", registrationId);
        } else {
          const body = await resp.text().catch(() => "");
          console.error(`[review-rate] low-score notification rejected by Resend (${resp.status}): ${body}`);
        }
      } catch (e) {
        // Non-fatal — the score is already recorded; a failed alert email must
        // not turn into a 500 that makes the family's tap look like it failed.
        // notified_at is NOT set here either, for the same reason as above.
        console.error("[review-rate] low-score notification failed:", e instanceof Error ? e.message : String(e));
      }
    }
  }

  // ---- Redirect to the org's landing page, or a plain thank-you if none is configured. ----
  const { data: org } = await supabase
    .from("organizations")
    .select("review_landing_url")
    .eq("id", orgId)
    .maybeSingle();
  const landingBase = (org?.review_landing_url ?? "").trim();
  if (!landingBase) {
    return textResponse("Thanks — your answer was recorded.");
  }
  // review_landing_url has no CHECK constraint enforcing a valid absolute URL
  // (free-text column) — a malformed value must degrade to the same plain
  // thank-you the "unset" case gets, never an unhandled crash on an
  // otherwise-valid, correctly-signed tap.
  let dest: URL;
  try {
    dest = new URL(landingBase);
  } catch {
    console.error(`[review-rate] organizations.review_landing_url is not a valid URL: ${landingBase}`);
    return textResponse("Thanks — your answer was recorded.");
  }
  dest.searchParams.set("score", String(score));
  if (programName) dest.searchParams.set("p", programName);
  return Response.redirect(dest.toString(), 302);
});

// =====================================================================
// HMAC token verification — same primitive as marketing-unsubscribe/index.ts
// (see _shared/hmac.ts), message shape extended to bind the score.
// =====================================================================

async function verifyToken(registrationId: string, orgId: string, score: number, token: string): Promise<boolean> {
  const expected = await computeToken(registrationId, orgId, score);
  return constantTimeEquals(expected, token);
}

async function computeToken(registrationId: string, orgId: string, score: number): Promise<string> {
  return hmacBase64Url(SECRET, `${registrationId}:${orgId}:${score}`);
}
