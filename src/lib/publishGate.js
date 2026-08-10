// publishGate — can this class go live to families yet?
//
// Arielle's rule, adopted by Jessica 2026-08-09: "it doesn't make any sense to
// publish a program if they can't get paid for it." This REVERSES the earlier
// "warn, don't block" behaviour on the same screens. The warning banners were a
// deliberate choice, not a bug; this supersedes them.
//
// THE RULE IS NOT "always require Stripe". It is: require Stripe when this
// class will actually take money through enrops. Three exemptions, each one a
// real org or a real set of rows on prod:
//
//   - the school collects        -> programs.runs_own_registration = true
//   - the class is free          -> programs.price_cents = 0
//   - the org registers elsewhere-> organizations.uses_enrops_registration = false
//                                   (shoreview-chess, mrs-richelle)
//
// This file is the ONE place the rule is written for the frontend. The database
// trigger `tg_programs_require_stripe_to_publish`
// (supabase/migrations/20260810c_require_stripe_to_publish.sql) is the same rule
// in SQL and is the actual enforcement — the Comms gate shipped UI-only the
// morning of 2026-08-09 and code review found it bypassable from devtools within
// hours. Change one of these two and you must change the other.
//
// WHAT THIS DELIBERATELY DOES NOT DO: it does not branch on
// instructor_pay_model. A trigger cannot see which nav shape an org gets, so a
// lean-only screen rule would mean the screens and the database enforce two
// different rules, one of them invisible. Jessica, 2026-08-10: gate everyone who
// takes money through enrops.

/**
 * Will this class collect money through enrops? Pure; takes the org row and the
 * program (or the in-progress form values shaped like one).
 *
 * `price_cents` missing counts as free, not as paid — the gate's job is to stop
 * a class that WILL take money, and a class with no price does not.
 */
export function takesMoneyThroughEnrops(org, program) {
  if (org?.uses_enrops_registration === false) return false;
  if (program?.runs_own_registration === true) return false;
  const price = Number(program?.price_cents ?? 0);
  return Number.isFinite(price) && price > 0;
}

/**
 * Should the publish control be blocked right now?
 *
 * Deliberately `=== false` on stripe_charges_enabled rather than `!`, matching
 * every other Stripe check in the admin: `undefined` means the org row (or the
 * charges lookup) has not resolved yet, and the safe direction is to leave the
 * control alone. Failing OPEN here costs one honest error message from the
 * database; failing CLOSED would strand a connected operator behind a button
 * they cannot press and cannot explain.
 *
 * DO NOT "simplify" this to `!org?.stripe_charges_enabled`. It reads like a typo
 * and it is not. The column is nullable but DEFAULT false, and measured on
 * 2026-08-10 there is no NULL anywhere: prod 0 null / 5 false / 2 true, staging
 * 0 null / 3 false / 5 true. So on every row that exists, `!` and `=== false`
 * agree — the ONLY case that separates them is the not-yet-loaded row this is
 * written to protect, where `!undefined` is true and would hide the publish
 * control from an operator whose Stripe is perfectly fine.
 */
export function publishBlockedByStripe(org, program) {
  if (!takesMoneyThroughEnrops(org, program)) return false;
  return org?.stripe_charges_enabled === false;
}

// Copy. One wording, used by all three publish paths, so the reason an operator
// reads on the lean builder is the reason they read on the program list.
// Jessica picked "name the fix, not the failure" 2026-08-10.
export const PUBLISH_GATE_CTA = "Connect Stripe to publish";
export const PUBLISH_GATE_WHY = "Families can't pay you until Stripe is connected.";
// For the two CREATE paths, where the class does not exist yet.
export const PUBLISH_GATE_DRAFT_HINT = "Save as draft keeps this class private in the meantime.";
// For the program list, where the class is ALREADY a draft — telling someone to
// "save as draft" a thing that is already a draft reads as a broken instruction.
export const PUBLISH_GATE_STAYS_DRAFT_HINT = "It stays a draft until then — nothing you've entered is lost.";
// Where the Stripe redirect actually starts. This is the ONLY route in the app
// that begins Connect; sending an operator anywhere else is a dead end.
export const STRIPE_CONNECT_ROUTE = "/admin/finances";

/**
 * The SQLSTATE the database trigger raises. Custom, so the frontend can tell
 * "you are not allowed to publish this" apart from a network failure or a
 * constraint violation and show the operator the fix instead of Postgres prose.
 */
export const PUBLISH_GATE_SQLSTATE = "ENRPS";

/**
 * Turn whatever came back from a publish write into something an operator can
 * act on. The trigger's own message is already written for them, so for our
 * error we pass it through; anything else is a genuine failure and keeps its
 * text rather than being papered over with a friendlier lie.
 */
export function publishErrorMessage(error) {
  if (!error) return "";
  if (error.code === PUBLISH_GATE_SQLSTATE) return error.message;
  return error.message ?? String(error);
}
