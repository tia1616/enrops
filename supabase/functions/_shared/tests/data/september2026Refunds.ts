// september2026Refunds — the seventeen refunds production took in September
// 2026, as ONE table.
//
// WHY IT MOVED OUT OF THE TEST FILE. Two things now read this month: the
// offline classifier test (_shared/tests/refundFeeReplay.test.ts) and the
// sandbox replay (scripts/sandbox-refund-replay.ts), which rebuilds each row as
// a real Stripe test-mode charge and runs the production modules over it. A
// second copy of a money fact is a future divergence — the same reason
// _shared/chargeFeeFacts.ts exists — so the month lives here and both import it.
//
// THE BAR THIS TABLE SERVES, in the money layer's own words (17 Sept 2026,
// section 6, blocker 1): "Definition of done: run the 17 September refunds
// through it in a sandbox and get 17 correct outcomes."
//
// WHERE EVERY NUMBER COMES FROM. The refund rows, organisations and charge
// amounts were read off the live production database on 2026-09-29:
//
//   select r.created_at, o.slug, o.stripe_charge_model, r.stripe_payment_intent_id,
//          r.amount_cents, r.platform_fee_refunded_cents, r.fee_return_outcome
//     from refunds r join organizations o on o.id = r.organization_id
//    where r.created_at >= '2026-09-01' and r.created_at < '2026-10-01'
//
// joined to `installments` and `registrations` for what the ORIGINAL charge was,
// which is the number the money layer insists on: "Do not reconcile against the
// refund amount. Reconcile each return against the original charge object."
//
// THE CHARGE IS NOT THE REFUND, and four rows prove it:
//   - Nehemiah Kalu and Wallace Fritsch were PARTIAL refunds (20500 of 24000,
//     6468 of 9968), so the margin comes back in proportion.
//   - Everett Myers was a partial refund of a pay-in-full charge.
//   - every Ukulele charge is class + pass-through fee (29900 + 299 = 30199),
//     so one percent of what the family paid is NOT the fee that was taken.
//
// PROD RECORDED 21 REFUNDS IN SEPTEMBER, NOT 17. Four more landed after the doc
// was written (23 and 28 September) and all four carry 'returned'. The
// definition of done names the seventeen that existed when it was set, so that
// is what this table holds; the count assertion below is about THIS set, not
// about the month as it stands today.

import type { FeeReturnOutcome } from '../../feeReturnOutcome.ts';

/** Which Stripe charge model the organisation was on at the time. */
export type ChargeModel = 'destination' | 'direct';

/**
 * Where `applicationFeeCents` came from. Provenance is recorded because the two
 * are not equally strong, and a replay that treats them as one would hide which
 * of its rows rest on an assumption.
 *
 *   'stripe'  read off the live charge object on 2026-09-18, during the
 *             reconciliation the money layer asked for.
 *   'derived' reconstructed from the org's rate and the charge: margin for a
 *             direct charge, margin + estimateStripeFee for a destination one.
 *             Every derived row's margin is confirmed by what production
 *             actually returned, so the derivation is checked, not assumed.
 *   'none'    the charge carries no application fee at all (registered before
 *             the fee existed).
 */
export type AppFeeSource = 'stripe' | 'derived' | 'none';

export interface SeptemberRow {
  who: string;
  /** MM-DD, Pacific, ordered as production recorded them. */
  day: string;

  // ── what the classifier is asked about ──────────────────────────────────
  /** refunds.amount_cents on prod — how much of the charge came back. */
  refundedCents: number;
  /** What the fee-return attempt actually returned, AT THE TIME. */
  returnedCents: number;
  /** What was owed at the time. */
  owedCents: number;
  /** Placeholder ids: only null vs non-null carries meaning offline. */
  applicationFeeId: string | null;
  /** Whether the applicationFees.createRefund call threw. */
  failed: boolean;
  expect: FeeReturnOutcome;

  // ── what the sandbox needs to rebuild the charge ────────────────────────
  model: ChargeModel;
  /** The ORIGINAL charge total in cents, not the refund. */
  chargeAmountCents: number;
  /** application_fee_amount taken on that charge, in cents. */
  applicationFeeCents: number;
  appFeeSource: AppFeeSource;
  /**
   * Set when the sandbox cannot reproduce production exactly. Stated per row
   * rather than in a footnote, so a replay result can never be read as proving
   * more than it did.
   */
  sandboxCaveat?: string;
}

export const SEPTEMBER_2026: SeptemberRow[] = [
  // ── twelve that returned the fee ────────────────────────────────────────
  {
    who: 'Wallace Fritsch', day: '09-01', model: 'destination',
    chargeAmountCents: 9968, applicationFeeCents: 420, appFeeSource: 'stripe',
    refundedCents: 6468, returnedCents: 66, owedCents: 66,
    applicationFeeId: 'fee_1', failed: false, expect: 'returned',
  },
  {
    who: 'Esme Rosenau', day: '09-01', model: 'direct',
    chargeAmountCents: 30199, applicationFeeCents: 299, appFeeSource: 'stripe',
    refundedCents: 30199, returnedCents: 299, owedCents: 299,
    applicationFeeId: 'fee_2', failed: false, expect: 'returned',
  },
  {
    who: 'Nehemiah Kalu', day: '09-03', model: 'destination',
    chargeAmountCents: 24000, applicationFeeCents: 966, appFeeSource: 'derived',
    refundedCents: 20500, returnedCents: 205, owedCents: 205,
    applicationFeeId: 'fee_3', failed: false, expect: 'returned',
  },
  {
    who: 'Murphy Yolland', day: '09-07', model: 'destination',
    chargeAmountCents: 28500, applicationFeeCents: 1142, appFeeSource: 'derived',
    refundedCents: 28500, returnedCents: 285, owedCents: 285,
    applicationFeeId: 'fee_4', failed: false, expect: 'returned',
  },
  {
    who: 'Amit Rasin', day: '09-08', model: 'destination',
    chargeAmountCents: 24000, applicationFeeCents: 966, appFeeSource: 'derived',
    refundedCents: 24000, returnedCents: 240, owedCents: 240,
    applicationFeeId: 'fee_5', failed: false, expect: 'returned',
  },
  {
    // The reversal case: Stripe labelled this one Reversed and the fee still
    // came back. Section 6's "handles the reversal case" tick.
    who: 'Leila Banks', day: '09-08', model: 'destination',
    chargeAmountCents: 9968, applicationFeeCents: 420, appFeeSource: 'stripe',
    refundedCents: 9968, returnedCents: 101, owedCents: 101,
    applicationFeeId: 'fee_6', failed: false, expect: 'returned',
  },

  // ── two that correctly returned nothing ─────────────────────────────────
  // Registered in June, before the fee existed, so the charge carries no
  // application fee to give back.
  {
    who: 'Lochlan Dillard', day: '09-08', model: 'destination',
    chargeAmountCents: 24000, applicationFeeCents: 0, appFeeSource: 'none',
    refundedCents: 24000, returnedCents: 0, owedCents: 0,
    applicationFeeId: null, failed: false, expect: 'nothing_owed',
  },
  {
    who: 'Adalyn Snowley', day: '09-08', model: 'destination',
    chargeAmountCents: 24000, applicationFeeCents: 0, appFeeSource: 'none',
    refundedCents: 24000, returnedCents: 0, owedCents: 0,
    applicationFeeId: null, failed: false, expect: 'nothing_owed',
  },

  // ── three that failed on an empty platform balance ──────────────────────
  // 371 + 240 + 101 = 712, exactly the $7.12 settled by hand on 9 September.
  // Recorded AS THEY HAPPENED: prod's platform_fee_refunded_cents is non-zero
  // on all three today because Jessica settled them in Stripe by hand.
  {
    who: 'Laura Lillison', day: '09-08', model: 'destination',
    chargeAmountCents: 28500, applicationFeeCents: 1142, appFeeSource: 'stripe',
    refundedCents: 28500, returnedCents: 0, owedCents: 371,
    applicationFeeId: 'fee_9', failed: true, expect: 'failed',
    sandboxCaveat:
      'owed 371 because this charge was funded by Link, which Stripe bills at ' +
      '2.6% + 30c (real fee 771, not the 857 the uplift assumed). Test mode ' +
      'cannot produce a Link-funded card, so the sandbox charge is billed at ' +
      '2.9% + 30c and the owed figure reads 285. The outcome word is unaffected.',
  },
  {
    who: 'Morgan Marlett', day: '09-08', model: 'destination',
    chargeAmountCents: 24000, applicationFeeCents: 966, appFeeSource: 'derived',
    refundedCents: 24000, returnedCents: 0, owedCents: 240,
    applicationFeeId: 'fee_10', failed: true, expect: 'failed',
  },
  {
    who: 'Addie Schmitt', day: '09-08', model: 'direct',
    chargeAmountCents: 10069, applicationFeeCents: 101, appFeeSource: 'stripe',
    refundedCents: 10069, returnedCents: 0, owedCents: 101,
    applicationFeeId: 'fee_11', failed: true, expect: 'failed',
  },

  // ── the rest of the month, all returned ─────────────────────────────────
  {
    who: 'Mia Simpson', day: '09-10', model: 'destination',
    chargeAmountCents: 28500, applicationFeeCents: 1142, appFeeSource: 'derived',
    refundedCents: 28500, returnedCents: 285, owedCents: 285,
    applicationFeeId: 'fee_12', failed: false, expect: 'returned',
  },
  {
    who: 'Rosie Wittmayer', day: '09-13', model: 'direct',
    chargeAmountCents: 30199, applicationFeeCents: 299, appFeeSource: 'derived',
    refundedCents: 30199, returnedCents: 299, owedCents: 299,
    applicationFeeId: 'fee_13', failed: false, expect: 'returned',
  },
  {
    who: 'Margot Burke', day: '09-13', model: 'direct',
    chargeAmountCents: 10069, applicationFeeCents: 101, appFeeSource: 'derived',
    refundedCents: 10069, returnedCents: 101, owedCents: 101,
    applicationFeeId: 'fee_14', failed: false, expect: 'returned',
  },
  {
    who: 'Clara Calcagno', day: '09-13', model: 'direct',
    chargeAmountCents: 30199, applicationFeeCents: 299, appFeeSource: 'derived',
    refundedCents: 30199, returnedCents: 299, owedCents: 299,
    applicationFeeId: 'fee_15', failed: false, expect: 'returned',
  },
  {
    who: 'Heidi Nelson', day: '09-14', model: 'direct',
    chargeAmountCents: 11079, applicationFeeCents: 111, appFeeSource: 'stripe',
    refundedCents: 11079, returnedCents: 111, owedCents: 111,
    applicationFeeId: 'fee_16', failed: false, expect: 'returned',
  },
  {
    // A partial refund of a pay-in-full charge: 32900 class + 329 fee = 33229
    // paid, 2500 refunded, so 329 x 2500/33229 = 24.75 -> 25 comes back.
    who: 'Everett Myers', day: '09-15', model: 'direct',
    chargeAmountCents: 33229, applicationFeeCents: 329, appFeeSource: 'derived',
    refundedCents: 2500, returnedCents: 25, owedCents: 25,
    applicationFeeId: 'fee_17', failed: false, expect: 'returned',
  },
];

/** The month's shape, asserted by both readers so neither can drift alone. */
export const SEPTEMBER_2026_SHAPE = {
  rows: 17,
  returned: 12,
  nothing_owed: 2,
  failed: 3,
  /** The $7.12 Jessica settled by hand on 9 September. */
  failedOwedTotalCents: 712,
} as const;
