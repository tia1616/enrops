// operatorAccountStatus — the ONE mapping from a Stripe Account object to
// organizations.stripe_account_status.
//
// WHY THIS FILE EXISTS. This logic was written twice: once in stripe-webhook's
// handleAccountUpdated and once in sync-operator-stripe-status, the second
// carrying the comment "IDENTICAL to handleAccountUpdated ... Keep these two in
// lockstep." Two copies of a rule an operator sees on their money screen is one
// copy too many, and stripe-oauth-callback needs the same rule, which would have
// made three. A status that differs by which code path ran is the same bug class
// as a number computed in two places.
//
// PURE ON PURPOSE. This function does not read or write the database and does
// not know about events. Every caller keeps its own guards, which are NOT the
// same and must not be merged:
//   - stripe-webhook:              idempotency on stripe_last_account_event_id,
//                                  the regression alert email, and writing
//                                  stripe_last_account_event_id.
//   - sync-operator-stripe-status: the early return that refuses to resurrect a
//                                  deliberately 'disconnected' org, and NOT
//                                  writing stripe_last_account_event_id (there
//                                  is no event).
//   - stripe-oauth-callback:       nothing extra; it writes the columns on first
//                                  connect.
// Folding any of those into this function would be deleting a guard.
//
// Extracted verbatim from stripe-webhook/index.ts handleAccountUpdated on
// 2026-07-29. The two originals were compared line by line first and were
// logically identical.

/**
 * The fields of a Stripe Account this mapping depends on. Deliberately a narrow
 * structural type rather than Stripe.Account: the v1 Accounts API returns these
 * for every account shape - Express, controller-based, and Standard accounts
 * connected via OAuth - which is exactly why sync-operator-stripe-status uses
 * accounts.retrieve rather than trusting a particular event payload.
 */
export interface OperatorAccountSnapshot {
  charges_enabled?: boolean | null;
  payouts_enabled?: boolean | null;
  details_submitted?: boolean | null;
  requirements?: { disabled_reason?: string | null } | null;
}

export type OperatorAccountStatus = 'active' | 'restricted' | 'verifying' | 'onboarding';

export interface OperatorAccountState {
  status: OperatorAccountStatus;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  disabledReason: string | null;
}

// Not every disabled_reason is the operator's problem. These two mean the
// opposite of "we need something from you" - the form is done,
// requirements.currently_due is empty, and Stripe is just reviewing (usually for
// well under a minute). Collapsing them into 'restricted' made the Finances
// screen tell an operator who had done everything correctly to go supply
// information Stripe wasn't asking for. Observed live 2026-07-27.
export const PENDING_REVIEW_REASONS = ['requirements.pending_verification', 'under_review'];

/**
 * Map Stripe's account state onto our enum. Six buckets exist on the column;
 * this function decides the four that are derivable from the account itself:
 *
 *   active        - charges + payouts both enabled
 *   verifying     - everything submitted, Stripe is REVIEWING, nothing required
 *                   from the operator
 *   restricted    - Stripe disabled the account for a reason the operator must
 *                   actually act on
 *   onboarding    - hasn't completed the onboarding form yet
 *
 * The other two are set elsewhere and this function must never return them:
 *   disconnected  - the operator deauthorized us (account.application.deauthorized)
 *   not_connected - never connected (set at insert time)
 */
export function mapOperatorAccountStatus(
  account: OperatorAccountSnapshot,
): OperatorAccountState {
  const chargesEnabled = account.charges_enabled === true;
  const payoutsEnabled = account.payouts_enabled === true;
  const detailsSubmitted = account.details_submitted === true;
  const disabledReason = account.requirements?.disabled_reason || null;

  const isPendingReview =
    disabledReason !== null && PENDING_REVIEW_REASONS.includes(disabledReason);

  let status: OperatorAccountStatus;
  if (chargesEnabled && payoutsEnabled) {
    status = 'active';
  } else if (detailsSubmitted && isPendingReview) {
    status = 'verifying';
  } else if (detailsSubmitted && !chargesEnabled && disabledReason) {
    status = 'restricted';
  } else {
    status = 'onboarding';
  }

  return { status, chargesEnabled, payoutsEnabled, detailsSubmitted, disabledReason };
}
