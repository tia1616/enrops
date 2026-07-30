// stripeDeauthorize — decide what a failed POST /oauth/deauthorize actually means.
//
// Extracted from stripe-oauth-disconnect so the three-way branch is testable.
// Getting it wrong is expensive in both directions: classify a real failure as
// "already done" and we mark an org disconnected while enrops still has live
// access to their account; classify a benign refusal as fatal and an operator
// who legitimately wants out is told to try again forever.
//
// Reference (docs.stripe.com/connect/oauth-reference, read 2026-07-30):
//   invalid_request  - a required parameter was missing.
//   invalid_client   - several distinct causes share this ONE code:
//                        * the client_id isn't ours
//                        * the stripe_user_id doesn't exist, or "isn't connected
//                          to your application"
//                        * live/test key mode doesn't match the client_id mode
//                        * no_deauth_on_controlled_account - the account cannot
//                          be deauthorized at all; Stripe points at the reject
//                          API instead.
// Because one code covers both "there is nothing to revoke" and "your platform
// credentials are wrong", the DESCRIPTION has to be read too. Anything we cannot
// positively identify is FATAL - the safe default is to leave the org connected
// and make a human look, never to assume the grant is gone.

export type DeauthorizeOutcome =
  /** The account is one the platform controls (we created it). There is no OAuth
   *  grant to revoke and nothing is left dangling: the account stays open and
   *  belongs to the operator. Unlink on our side. */
  | 'controlled_account'
  /** Stripe says the grant is not there - most often because the operator
   *  already revoked us from their own Stripe dashboard. Our row is the thing
   *  that is out of date, so unlink. */
  | 'already_gone'
  /** Anything else, including every "our credentials are wrong" case. Do NOT
   *  touch the org row. */
  | 'fatal';

/** Substrings that identify the account as platform-controlled. */
const CONTROLLED = /no_deauth_on_controlled_account/i;

/**
 * "The grant isn't there" wording. Deliberately NARROW: it must not match
 * `invalid_client` on its own, because that same code is returned when OUR
 * client_id is wrong or when a test key was used against a live client_id -
 * platform misconfiguration that must never be read as "already disconnected".
 * Matching it would silently disconnect every org the moment a key was rotated
 * incorrectly.
 */
const ALREADY_GONE = /(isn'?t connected|is not connected|not connected to your application|no such account|does not exist|doesn'?t exist)/i;

export function classifyDeauthorizeError(
  code: string | null | undefined,
  description: string | null | undefined,
): DeauthorizeOutcome {
  const c = code ?? '';
  const d = description ?? '';
  if (CONTROLLED.test(c) || CONTROLLED.test(d)) return 'controlled_account';
  if (ALREADY_GONE.test(d) || ALREADY_GONE.test(c)) return 'already_gone';
  return 'fatal';
}
