// termsOfService — is this business on the current enrops Terms of Service, and
// how does an owner accept them.
//
// NAMED THE LONG WAY ON PURPOSE. src/lib/terms.js already exists in this
// codebase and means something completely different: SCHOOL terms, as in Fall,
// Winter and Spring. Finances.jsx imports that one already. Two modules called
// terms-something, one about a school calendar and one about a legal agreement,
// is a wrong import waiting to happen in a file that touches money - so this one
// says what it is and never shortens to `terms`.
//
// Money layer (17 Sept 2026) item 7, section 12: "Acceptance tracked by version
// and date for each organisation" and "Businesses on older Terms re-accept at
// next login".
//
// ONE READER AND ONE WRITER, because three separate money settings consult this
// and a second spelling would let them disagree about whether the same business
// is current.
//
// WHERE THE GATE IS, AND WHY IT IS NOT A BANNER. An earlier draft put a
// disclosure in the admin shell so it appeared above every page. Jessica ruled
// that exact shape out on 2026-07-30, for the starter cancellation-policy
// notice: a disclosure with nothing to do with the screen you are on reads as an
// interruption, and it follows you everywhere until you answer it. The comment
// recording that decision is still in AdminLayout at the old mount point.
//
// So this gates the three writes that actually need the terms - the ones on the
// money page that change what families pay and what the business is called on a
// statement - and the prompt sits at the top of that same page.
//
// PAGE LEVEL, not beside the settings, and that is a correction. The prompt was
// first put inside the "Manage setup" section next to the fee toggle, which
// renders only when Stripe is active AND the operator has expanded it - while
// FeePayerRow is deliberately hoisted OUT of that section and shown always for
// registration operators. The result was an operator clicking the visible toggle,
// being told to accept the terms, and having no accept button on screen.
//
// Nothing else changes, and nothing is hidden: an operator can still SEE every
// number on that page. Blocking the view would punish someone for paperwork by
// taking away sight of their own payouts, which is not what the exposure is.

import { supabase } from "./supabase";

/**
 * What the database says about this organisation's terms.
 *
 * Shape mirrors public.org_terms_status(uuid) exactly, plus `ok`, which says
 * whether the answer is trustworthy at all.
 */
export const TOS_STATUS_UNKNOWN = {
  ok: false,
  currentVersion: null,
  acceptedVersion: null,
  acceptedAt: null,
  needsAcceptance: false,
};

/**
 * Read the status. Never throws; returns TOS_STATUS_UNKNOWN on failure.
 *
 * THE FAIL DIRECTION, NAMED OUT LOUD, because a money-path read that quietly
 * answers "no" is the bug class that keeps recurring here. On failure this
 * returns needsAcceptance FALSE, which lets the money settings save.
 *
 * That is deliberate and it is the smaller harm. Failing closed would mean a
 * transient RPC error locks EVERY operator out of their own money settings,
 * while the feature is inert for everyone until a version is published at all.
 * Failing open costs at most a short window in which a business edits a fee
 * before its acceptance is on record - and nothing is lost by that, because the
 * record is still absent and the gate still catches them next time. No money
 * moves either way. If that trade ever stops being true, this is the line to
 * change, and the comment is here so the next person knows it was a choice.
 */
export async function fetchTermsOfServiceStatus(orgId) {
  if (!orgId) return TOS_STATUS_UNKNOWN;

  // The error is READ, not dropped. `const { data } = await ...` would turn a
  // failed read into an empty array and then into "nothing is needed", which
  // reads identically to a real answer.
  const { data, error } = await supabase.rpc("org_terms_status", { p_org: orgId });
  if (error) {
    console.error("[termsOfService] could not read terms status:", error);
    return TOS_STATUS_UNKNOWN;
  }

  // The function returns a table, so PostgREST hands back an array of one row.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return TOS_STATUS_UNKNOWN;

  return {
    ok: true,
    currentVersion: row.current_version ?? null,
    acceptedVersion: row.accepted_version ?? null,
    acceptedAt: row.accepted_at ?? null,
    needsAcceptance: !!row.needs_acceptance,
  };
}

/**
 * Record that this organisation accepts `version`.
 *
 * Only an owner may do this - the database enforces it (the insert policy is
 * is_org_owner), so this is not a client-side rule that a different caller could
 * skip. An admin pressing it would get a policy refusal, which is why the UI
 * does not offer the button to one.
 *
 * Idempotent by construction: the table has a unique constraint on
 * (organization_id, terms_version), so a double press is one acceptance rather
 * than two rows. 23505 is therefore success, not failure.
 */
export async function acceptTermsOfService(orgId, version, userId, email) {
  if (!orgId || !version) {
    return { ok: false, reason: "missing_org_or_version" };
  }

  const { error } = await supabase.from("org_terms_acceptances").insert({
    organization_id: orgId,
    terms_version: version,
    accepted_by_user_id: userId,
    accepted_by_email: email ?? null,
  });

  if (!error) return { ok: true };

  // Already recorded - the unique constraint did its job. The business IS on
  // the current terms, so reporting a failure here would be a lie that sends an
  // owner to press the button again forever.
  if (error.code === "23505") return { ok: true, alreadyAccepted: true };

  // 42501 is the policy refusing a non-owner. Named separately because "you are
  // not the owner" and "something went wrong" need different sentences.
  if (error.code === "42501") return { ok: false, reason: "not_owner" };

  console.error("[termsOfService] accepting terms failed:", error);
  return { ok: false, reason: "error", error };
}
