// feeReturnOutcome — what happened when we tried to return the enrops service
// fee on a refund, as one of three words instead of an inference.
//
// WHY THIS EXISTS. Money layer (16 Sept 2026) section 6, blocker 1, fifth
// checkbox: "logs every attempt, success or failure, somewhere we can both
// see". Until now only FAILURES wrote anything, and only as prose in
// refunds.failure_reason. A success wrote a number, and `0` in that number
// meant two different things:
//
//   - nothing was owed (the charge carried no enrops margin: the pre-29-June
//     registrations, or an org whose fee model has no uplift to recover), or
//   - we tried and could not (the platform balance was too low).
//
// On 8 September three fee returns failed and it took a hand audit of prod to
// find them, because nothing on any screen distinguished those two zeroes.
// From 1 November the same miss stops being a business left short and becomes
// a family not getting their money back, which is why this is a blocker.
//
// TWO CALLERS, ONE RULE. refund-registration (an operator refunding inside
// enrops) and stripe-webhook's charge.refunded (an operator refunding in their
// own Stripe dashboard) must label the same situation the same way, or the
// money page tells a different story depending on where the refund started.
// Same reason _shared/chargeFeeFacts.ts exists.

/**
 * The recorded outcome of one fee-return attempt.
 *
 * `null` is also a legal value in the column and means "no outcome was
 * recorded", which covers every refund written before this shipped and the one
 * case below that genuinely cannot be classified. It is deliberately NOT a
 * fourth word: a row with no outcome is an incomplete record, and reading it
 * as a state would make it look finished.
 */
export type FeeReturnOutcome = 'returned' | 'nothing_owed' | 'failed';

export interface FeeReturnFacts {
  /** Cents of margin this refund should return. 0 when none is owed. */
  owedCents: number;
  /** The ApplicationFee the margin would come from. null when no fee was taken. */
  applicationFeeId: string | null;
  /** Cents actually returned. */
  returnedCents: number;
  /** Set when the attempt threw. */
  failed: boolean;
}

/**
 * Classify one attempt.
 *
 * FAIL-SAFE BY CONSTRUCTION: anything owed that did not come back is `failed`,
 * including the shapes nobody expects. A wrong `failed` costs somebody a look
 * at a row that turns out to be fine. A wrong `nothing_owed` hides money from
 * an operator, which is the bug this column exists to end, and it hides it
 * silently. So the tie always breaks towards visible.
 */
export function feeReturnOutcome(facts: FeeReturnFacts): FeeReturnOutcome {
  const owed = Number.isFinite(facts.owedCents) ? facts.owedCents : 0;
  const returned = Number.isFinite(facts.returnedCents) ? facts.returnedCents : 0;

  // ORDER MATTERS, and an earlier draft got it wrong. Checking "was anything
  // owed" first meant a NaN amount collapsed to 0 and returned 'nothing_owed'
  // while facts.failed was true, ignoring an attempt that had actually thrown.
  // That is a fail-OPEN in the one function whose job is to fail safe, and its
  // own test caught it. The three questions are now asked worst-consequence
  // first.

  // 1. Did money move? Then it was returned, whatever anyone thought was owed.
  if (returned > 0) return 'returned';

  // 2. Did the attempt throw? Then it failed - and we only ever attempt when
  //    something is owed against a real ApplicationFee, so this cannot be a
  //    false alarm on a charge that owed nothing. Asked BEFORE the amounts,
  //    because the amounts are exactly what is untrustworthy in this branch.
  if (facts.failed) return 'failed';

  // 3. Nothing moved and nothing threw. Either nothing was owed, which is a
  //    correct outcome and must stop reading as a skip...
  if (owed <= 0 || !facts.applicationFeeId) return 'nothing_owed';

  // ...or something was owed, no error was raised, and nothing came back. Not a
  // shape the current code can produce - createRefund would have to resolve
  // with a zero amount - but the operator is short either way, so it is
  // flagged rather than filed as "nothing owed" and forgotten.
  return 'failed';
}
