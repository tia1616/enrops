// What happens after a payment-plan charge fails: the failed-payment policy
// Arielle signed off on 2026-10-07 ("whatever Claude recommends as best
// practice"), written down once so the charger, its tests and anything that
// later explains the policy to a human all read the same numbers.
//
//   - A card decline is retried automatically 3 days later, and again 4 days
//     after that (day 7). Most declines on a saved card are a short-term low
//     balance, and they clear on their own.
//   - A decline whose code says the card itself is dead (lost, stolen, expired,
//     closed, "do not try again") is NOT retried. Retrying those cannot work,
//     and the card networks penalise merchants who keep trying them.
//   - Anything that is not a decline from the family's bank (a Stripe outage, a
//     timeout) is not retried automatically either: we cannot be sure it did not
//     charge, and a second key on an unknown outcome is how a family pays twice.
//   - After the last retry fails, we stop. The family gets one last email, the
//     business is told it is theirs to follow up, and nobody is removed and no
//     late fee is charged.
//   - A NEW card resets the cycle: it gets its own two retries.

/**
 * Registration states whose payment plan must never be charged again: the
 * business removed the family (cancelled) or gave the money back (refunded).
 * One list, read by every place that decides whether a plan row may be charged
 * - the retry re-arm and the charger itself - so the rule cannot drift.
 *
 * A DENY-list on purpose, like the instalment-status lists in this codebase:
 * 'pending' and 'waitlist' registrations do not normally carry instalments,
 * and if one ever does, blocking it here would silently stop a family's plan
 * on a state nobody chose to block.
 */
export const NOT_CHARGEABLE_REGISTRATION_STATUSES: readonly string[] = ['cancelled', 'refunded'];

/** Days to wait before each automatic retry, counted from the previous attempt.
 *  [3, 4] = retry 1 on day 3, retry 2 on day 7. */
export const RETRY_GAPS_DAYS: readonly number[] = [3, 4];

/**
 * Decline codes that mean trying the same card again cannot succeed. Matched
 * against both Stripe's `decline_code` and its `code`, because a dead card can
 * arrive either way (`code: 'expired_card'` carries no decline_code;
 * `code: 'card_declined', decline_code: 'stolen_card'` does).
 *
 * Anything NOT on this list is treated as temporary and retried. That is the
 * safe default: two extra attempts on a card that was going to fail anyway cost
 * nothing, while skipping a retry on insufficient_funds costs the family a
 * fixable payment.
 */
export const NO_RETRY_DECLINE_CODES: ReadonlySet<string> = new Set([
  'authentication_required', // needs the family present to approve it
  'card_not_supported',
  'currency_not_supported',
  'do_not_try_again',
  'expired_card',
  'fraudulent',
  'incorrect_number',
  'invalid_account',
  'invalid_number',
  'lost_card',
  'merchant_blacklist',
  'new_account_information_available',
  'pickup_card',
  'restricted_card',
  'revocation_of_all_authorizations',
  'revocation_of_authorization',
  'security_violation',
  'service_not_allowed',
  'stolen_card',
  'stop_payment_order',
  'transaction_not_allowed',
]);

export type DeclineOutcome =
  /** A retry is booked for `nextRetryOn`. */
  | 'retry_scheduled'
  /** Every automatic retry on this card has been used. */
  | 'retries_exhausted'
  /** The bank said this card cannot be charged again. */
  | 'hard_decline'
  /** Not a decline from the family's bank, so no automatic retry. */
  | 'not_a_decline';

export interface DeclinePlan {
  outcome: DeclineOutcome;
  /** 'YYYY-MM-DD' (UTC, same calendar as installments.due_date), or null. */
  nextRetryOn: string | null;
  /** Which retry nextRetryOn is (1-based). null when none is booked. */
  retryNumber: number | null;
  totalRetries: number;
}

/**
 * Decide what happens after a failed charge.
 *
 * @param isCardDecline  the error was the family's bank declining the card
 *                       (Stripe's StripeCardError) - money definitely did not
 *                       move.
 * @param codes          Stripe's decline_code and code, either may be missing.
 * @param retriesDone    automatic retries ALREADY attempted on this same card,
 *                       including the one that just failed. 0 = this was the
 *                       first attempt on this card.
 * @param today          'YYYY-MM-DD', UTC.
 */
export function planDeclineRetry({ isCardDecline, codes, retriesDone, today }: {
  isCardDecline: boolean;
  codes: Array<string | null | undefined>;
  retriesDone: number;
  today: string;
}): DeclinePlan {
  const totalRetries = RETRY_GAPS_DAYS.length;
  const none = (outcome: DeclineOutcome): DeclinePlan =>
    ({ outcome, nextRetryOn: null, retryNumber: null, totalRetries });

  if (!isCardDecline) return none('not_a_decline');
  if (codes.some((c) => !!c && NO_RETRY_DECLINE_CODES.has(c))) return none('hard_decline');

  // A negative or fractional count would be a bug upstream; floor it to a
  // valid index rather than booking a retry the schedule does not have.
  const done = Math.max(0, Math.floor(Number.isFinite(retriesDone) ? retriesDone : 0));
  if (done >= totalRetries) return none('retries_exhausted');

  return {
    outcome: 'retry_scheduled',
    nextRetryOn: addDaysUtc(today, RETRY_GAPS_DAYS[done]),
    retryNumber: done + 1,
    totalRetries,
  };
}

/**
 * Who hears about a failed charge. Pure, so the branching that decides what a
 * family and a business are told is tested rather than read.
 *
 * @param retriesDone        retries already attempted on THIS card (as passed
 *                           to planDeclineRetry). > 0 means this attempt was
 *                           one of our automatic retries.
 * @param familyAlreadyTold  the first decline email already went out for this
 *                           plan (parent_notified_failed_at is set).
 * @param hasEmail           the family has an address on file.
 */
export function declineFollowUp({ plan, retriesDone, familyAlreadyTold, hasEmail }: {
  plan: DeclinePlan;
  retriesDone: number;
  familyAlreadyTold: boolean;
  hasEmail: boolean;
}): { familyEmail: 'first' | 'final' | null; alertBusiness: boolean } {
  // A failed retry with another still booked says nothing new to anyone: the
  // family was told on the first decline and the business was given the dates.
  if (retriesDone > 0 && plan.outcome === 'retry_scheduled') {
    return { familyEmail: null, alertBusiness: false };
  }
  // The final email is the one exception to "tell the family once": it says
  // something new (we have stopped trying).
  if (plan.outcome === 'retries_exhausted') {
    return { familyEmail: hasEmail ? 'final' : null, alertBusiness: true };
  }
  return { familyEmail: hasEmail && !familyAlreadyTold ? 'first' : null, alertBusiness: true };
}

/** 'YYYY-MM-DD' + n days, in UTC so the date never shifts with a timezone. */
export function addDaysUtc(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The idempotency key for a payment-plan charge.
 *
 * The first attempt keeps the key the charger has always used, so a cron that
 * fires twice in one day still cannot charge twice. Every attempt AFTER a
 * decline gets a new one, because Stripe replays a saved result for a reused
 * key: without this, a retry (or a charge on a card the family has just
 * replaced) could be answered with the old decline without ever reaching the
 * bank, or refused outright because the card on the request changed.
 *
 * `priorDeclines` counts only attempts that DEFINITELY did not charge (card
 * declines and idempotency refusals). An attempt with an unknown outcome - a
 * timeout - keeps its key, so retrying it can only ever return the original
 * result rather than make a second charge.
 */
export function chargeIdempotencyKey(sortedRowIds: string[], priorDeclines: number): string {
  const base = `installment_group_${sortedRowIds.join('_')}`;
  return priorDeclines > 0 ? `${base}_d${priorDeclines}` : base;
}

/** "Friday, October 10" for a 'YYYY-MM-DD' date, read as a calendar date. */
export function formatRetryDate(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}
