// Operator-facing copy for a failed write to `organizations`.
//
// WHY THIS IS SHARED. Three controls on the Payments page write to this table
// (the fee-payer toggle, the statement-descriptor suffix, the withdrawal admin
// fee) and each used to render `err.message` straight through. That message is
// developer text: the platform-admin guard replies with a list of raw column
// names ("stripe_account_id, the platform fee rate, floor and cap columns,
// stripe_fee_payer, ..."), which no operator can act on. Written once here so a
// wording change lands on all three.
//
// THE RULE EACH STRING FOLLOWS: the advice has to be TRUE for the state that
// produced the code. Finances.jsx already learned this once - it had told an
// operator whose session had lapsed to "try again in a moment", advice that can
// never work - and the first version of this mapping reintroduced it by answering
// "check your connection" to an expired JWT and to a CHECK violation.
//
// TODO(copy): Arielle owns operator-facing wording. These are drafts.

// `err` is the supabase-js error, or null/undefined for the 0-rows-updated case -
// which is NOT a transport error: PostgREST returns 204 with no error when RLS
// filters the target row out, so "no rows" is the only signal that a write was
// silently discarded.
export function describeOrgSaveFailure(err) {
  const code = err?.code;

  // Session gone. Retrying the same click cannot help; signing in again can.
  if (code === "PGRST301" || code === "401") {
    return "Your sign-in has expired, so this wasn't saved. Sign in again and retry.";
  }

  // A CHECK constraint on the row rejected it. Constraints are re-evaluated on
  // every UPDATE of the row, so an invalid value in a DIFFERENT column (e.g.
  // organizations_alert_email_format) blocks this save with nothing on this screen
  // looking wrong - which is why this does not tell them to fix their input.
  if (code === "23514") {
    return "That didn't save because another setting on your account is invalid. Contact enrops and we'll sort it out.";
  }

  // The platform-admin guard (guard_organizations_locked_columns). Since
  // 20260806a, fee_pass_through is NOT in its list, so a 42501 on that column
  // means an RLS denial rather than a platform lock - both are "not yours to
  // change from here", which is what this says without claiming which.
  if (code === "42501") {
    return "That didn't save - this setting is managed by enrops. Contact us and we'll change it for you.";
  }

  // No error object at all, so the request succeeded and changed nothing: RLS
  // filtered the row out. In practice this account's permissions changed while the
  // page was open.
  if (!err) {
    return "That didn't save - your access may have changed. Reload the page and check you're still an owner or admin.";
  }

  return "That didn't save, so nothing changed. Try again, and tell us if it keeps happening.";
}
