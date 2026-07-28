// refundFeeSplit — how much of the application fee goes back on a refund.
//
// WHY THIS EXISTS. On a destination charge the application fee is deliberately
// larger than Enrops's margin: it is `margin + estimateStripeFee` whenever the
// provider bears Stripe's processing fee (stripe_fee_payer='tenant'). See
// _shared/connectChargeParams.ts. Stripe debits its own processing fee from the
// PLATFORM balance, so that uplift is what actually passes the cost through to
// the provider.
//
// On a refund those two halves must be treated DIFFERENTLY, which a boolean
// `refund_application_fee` cannot express:
//
//   - the MARGIN half is refundable. Enrops did not earn a margin on a
//     registration that got cancelled, so it goes back.
//   - the STRIPE-FEE half is NOT refundable, because Stripe never returns it:
//     "Stripe's processing fees from the original transaction aren't returned"
//     (docs.stripe.com/refunds). Pushing that half back to the provider means
//     Enrops pays Stripe out of its own pocket on every refund.
//
// So the refund refunds the MARGIN ONLY. Outcome on a refunded $100 class:
// family whole ($103.00 back), provider bears Stripe's real $3.29, Enrops nets
// $0. Nobody profits from a cancellation, and nobody is quietly subsidising it.
// Decided by Jessica 2026-07-25, superseding the earlier "Enrops absorbs it".
//
// The numbers are read from Stripe at refund time (the real application fee and
// the real balance-transaction fee), NOT recomputed from org rate config — a
// provider's rates can change between the charge and the refund, and the charge
// is the authoritative record of what was actually taken.

export interface MarginRefundInput {
  /** application_fee_amount actually taken on the charge, in cents. */
  applicationFeeCents: number;
  /** Stripe's real processing fee for the charge, from the balance transaction. */
  stripeFeeCents: number;
  /** The charge's total amount in cents (what the family paid on this PI). */
  chargeAmountCents: number;
  /** How much of that charge is being refunded right now, in cents. */
  refundAmountCents: number;
  /** Application fee already refunded on earlier partial refunds, in cents. */
  alreadyRefundedFeeCents?: number;
  /**
   * Fraction of the program still undelivered, 0..1, from
   * _shared/refundFeeProration.ts. Arielle's v4 section 2: "Set Enrops' fee
   * refund = application_fee x % remaining" - 100% before the program starts,
   * straight-line by sessions remaining mid-program, 0% once it has ended.
   *
   * Defaults to 1, which is the pre-proration behaviour: refund the whole
   * recoverable margin. Every caller that cannot resolve a schedule leaves it
   * at 1 rather than guessing, so an unknown calendar can never make Enrops
   * KEEP a fee it has not justified.
   *
   * Applied ONLY to our fee. It can never reduce what the family gets back -
   * card network rules prohibit shorting the cardholder (v4 section 2).
   */
  remainingFraction?: number;
}

/**
 * Cents of the application fee to refund. Returns 0 rather than a negative or
 * an over-refund in every degenerate case, so the caller can always pass the
 * result straight to Stripe (or skip the call when it is 0).
 */
export function computeMarginRefund(input: MarginRefundInput): number {
  const {
    applicationFeeCents,
    stripeFeeCents,
    chargeAmountCents,
    refundAmountCents,
    alreadyRefundedFeeCents = 0,
    remainingFraction = 1,
  } = input;

  // Clamp rather than trust: a fraction outside 0..1 (or NaN from a bad date)
  // must not turn into a negative refund or an over-refund.
  const fraction = Number.isFinite(remainingFraction)
    ? Math.min(1, Math.max(0, remainingFraction))
    : 1;

  // Nothing to give back if no fee was taken, or the refund is empty/invalid.
  if (!(applicationFeeCents > 0)) return 0;
  if (!(refundAmountCents > 0)) return 0;
  if (!(chargeAmountCents > 0)) return 0;

  // The recoverable half. If Stripe's fee somehow met or exceeded the whole
  // application fee there is no margin to return — clamp at 0 rather than
  // going negative and accidentally CHARGING the provider on a refund.
  const marginTotal = Math.max(0, applicationFeeCents - Math.max(0, stripeFeeCents));
  if (marginTotal === 0) return 0;

  // Full (or over-) refund: hand back the whole remaining margin exactly.
  // Computing this proportionally would drift by a cent on odd amounts, and
  // "refund everything" must mean everything.
  const isFullRefund = refundAmountCents >= chargeAmountCents;
  const marginForThisRefund = isFullRefund
    ? marginTotal
    : Math.round((marginTotal * refundAmountCents) / chargeAmountCents);

  // v4 section 2: our fee comes back in proportion to the program NOT delivered.
  // Composed with the share above, so a half refund of a half-delivered program
  // returns a quarter of the margin. Both of v4's stated endpoints still hold
  // exactly: a full refund before the first session returns 100%, and any refund
  // after the last session returns 0%.
  const wanted = Math.round(marginForThisRefund * fraction);

  // Never refund more margin than is left. Two ceilings apply: what remains of
  // the margin, and what remains of the application fee overall (Stripe rejects
  // a fee refund that exceeds the fee, which would fail the whole call).
  const alreadyRefunded = Math.max(0, alreadyRefundedFeeCents);
  const marginRemaining = Math.max(0, marginTotal - alreadyRefunded);
  const feeRemaining = Math.max(0, applicationFeeCents - alreadyRefunded);

  return Math.max(0, Math.min(wanted, marginRemaining, feeRemaining));
}
