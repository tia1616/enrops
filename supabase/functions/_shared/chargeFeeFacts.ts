// chargeFeeFacts — read the REAL money numbers off a charge, for both charge
// models, in one place.
//
// WHY A SHARED MODULE. Two callers need identical numbers or they will disagree
// about how much of Enrops's fee to give back:
//   - refund-registration  (an operator refunding inside Enrops)
//   - stripe-webhook       (charge.refunded: an operator refunding inside their
//                           OWN Stripe dashboard - Arielle's v4 section 3)
// v4 section 3 requires the second path to produce the same fee refund as the
// first "regardless of whether the refund was started in Enrops or directly in
// Stripe". Two implementations of this arithmetic would be two answers.
//
// EVERYTHING HERE IS READ FROM STRIPE, NEVER RECOMPUTED FROM ORG CONFIG. A
// provider's rates can change between the charge and the refund; the charge is
// the authoritative record of what was actually taken.
//
// THE ONE ASYMMETRY THAT MATTERS - whose balance paid Stripe's processing fee:
//
//   DESTINATION charge (platform-scoped, J2S and every pre-existing org):
//     Stripe debits ITS fee from the PLATFORM balance, and the application fee
//     was sized up to recover it (margin + estimateStripeFee, see
//     connectChargeParams.ts). Stripe never returns its own fee on a refund, so
//     the recoverable part is application_fee MINUS the real Stripe fee.
//     Verified 2026-07-27 by a real charge: platform charge +27674 with an 833
//     Stripe fee debited from Enrops.
//
//   DIRECT charge (on the connected account, controller-based accounts):
//     Stripe debits its fee from the OPERATOR's balance and never touches ours,
//     and the application fee carries no uplift. So the whole application fee is
//     clean margin and stripeFeeCents is 0 - subtracting the operator's own fee
//     here would under-refund them twice over.
//     Verified 2026-07-27: operator charge 6199 fee 409, platform
//     application_fee +199 fee 0.
//
// The ApplicationFee object itself always belongs to the PLATFORM, on both
// models - "Funds will be refunded to the Stripe account from which the fee was
// originally collected" (docs.stripe.com/api/fee_refunds/create). So it is
// retrieved and refunded platform-scoped, with NO Stripe-Account header, even
// when the charge it came from lives on a connected account. Only the charge
// read is account-scoped.

/**
 * PaymentIntent metadata key carrying the Stripe-fee uplift, in cents.
 *
 * Declared here rather than imported from upliftTrueUp so that the READER of
 * this fact does not depend on the module that acts on it; upliftTrueUp
 * re-exports the same literal for its writers, and a test pins the two equal.
 */
export const UPLIFT_METADATA_KEY = 'enrops_uplift_cents';

/** Parse the recorded uplift. Anything not a clean non-negative integer is null. */
function readRecordedUplift(metadata: Record<string, unknown> | null | undefined): number | null {
  const raw = metadata?.[UPLIFT_METADATA_KEY];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  // Number('') is 0 and Number(null) is 0, which is why both are excluded
  // above: a missing uplift must read as "unknown", never as "zero uplift".
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

interface StripeLike {
  paymentIntents: {
    retrieve(id: string, params?: unknown, options?: unknown): Promise<unknown>;
  };
  applicationFees: {
    retrieve(id: string, params?: unknown, options?: unknown): Promise<unknown>;
  };
}

export interface ChargeFeeFacts {
  /** ApplicationFee id, platform-scoped. null when no fee was taken. */
  applicationFeeId: string | null;
  /** application_fee_amount actually taken on the charge, in cents. */
  applicationFeeCents: number;
  /** The charge's total, in cents - what the family actually paid on this PI. */
  chargeAmountCents: number;
  /**
   * Stripe's processing fee that came out of OUR balance, in cents.
   * Always 0 on a direct charge (see the header). */
  stripeFeeCents: number;
  /** Application fee already refunded, in cents - the idempotency ceiling. */
  alreadyRefundedFeeCents: number;
  /**
   * The Stripe-fee uplift that went INTO this charge's application fee, in
   * cents, as recorded on the PaymentIntent at creation.
   *
   * NULL when the charge carries no such metadata - it predates the change, or
   * was not created by us. Callers must treat null as "do nothing" rather than
   * reconstructing a number: the uplift is sized on the registration total
   * while the charge also carries the pass-through fee line, so any attempt to
   * recompute it from the charge amount overstates it. See _shared/upliftTrueUp.ts.
   */
  recordedUpliftCents: number | null;
  /**
   * Fee refunds already issued against this ApplicationFee, with their metadata.
   *
   * This is what makes "did we already return our fee for THIS Stripe refund?"
   * an observable fact instead of an inference. Recording a refund and
   * returning the fee are two writes against two systems, so a retry has to be
   * able to tell a half-finished job from a finished one - and a Stripe
   * idempotency key cannot answer that, because the same key errors out
   * whenever the recomputed amount differs even slightly.
   */
  feeRefunds: Array<{ id: string; amount: number; metadata: Record<string, string> }>;
}

/** Metadata key tagging a fee refund with the Stripe refund that caused it. */
export const FEE_REFUND_SOURCE_KEY = 'enrops_source_refund_id';
/** Metadata key tagging which registration's share it covered. */
export const FEE_REFUND_REGISTRATION_KEY = 'enrops_registration_id';

/**
 * Read the fee facts for one PaymentIntent.
 *
 * Throws on failure rather than returning zeros. A zero here would look exactly
 * like "no fee to refund" and would silently short the operator, so callers
 * must decide explicitly what to do when Stripe cannot be read.
 *
 * @param chargeAccountId the account the charge was created on; null = platform.
 */
export async function readChargeFeeFacts(
  stripe: StripeLike,
  paymentIntentId: string,
  chargeAccountId: string | null,
): Promise<ChargeFeeFacts> {
  // The charge is read on the account it lives on. balance_transaction is
  // expanded because it carries Stripe's REAL fee - estimateStripeFee is only
  // ever the estimate the uplift was sized from at charge time.
  //
  // application_fee is deliberately NOT expanded: it is a platform object, and
  // expanding it from a connected account's context is not something to rely
  // on. The id is present on the charge either way, and the object is fetched
  // platform-scoped below.
  const pi = await stripe.paymentIntents.retrieve(
    paymentIntentId,
    { expand: ['latest_charge.balance_transaction'] },
    chargeAccountId ? { stripeAccount: chargeAccountId } : undefined,
  );

  const piTyped = pi as {
    metadata?: Record<string, unknown> | null;
    latest_charge?: {
      amount?: number;
      application_fee_amount?: number | null;
      application_fee?: { id?: string } | string | null;
      balance_transaction?: { fee?: number } | string | null;
      metadata?: Record<string, unknown> | null;
    } | null;
  };
  const charge = piTyped.latest_charge ?? null;
  // The PaymentIntent's own metadata is the record we wrote; Stripe also copies
  // it down onto the Charge, so the charge is read as a fallback rather than a
  // second source of truth.
  const piMetadata = piTyped.metadata ?? charge?.metadata ?? null;

  const applicationFeeId =
    typeof charge?.application_fee === 'string'
      ? charge.application_fee
      : charge?.application_fee?.id ?? null;

  const bt = typeof charge?.balance_transaction === 'object' ? charge?.balance_transaction : null;

  let alreadyRefundedFeeCents = 0;
  let feeRefunds: ChargeFeeFacts['feeRefunds'] = [];
  if (applicationFeeId) {
    // Platform-scoped on purpose - see the header. Passing the connected
    // account here would 404 on a resource that is not theirs.
    const fee = await stripe.applicationFees.retrieve(applicationFeeId, { expand: ['refunds'] });
    const f = fee as {
      amount_refunded?: number;
      refunds?: { data?: Array<{ id: string; amount?: number; metadata?: Record<string, string> }> };
    };
    alreadyRefundedFeeCents = f.amount_refunded ?? 0;
    feeRefunds = (f.refunds?.data ?? []).map((r) => ({
      id: r.id,
      amount: r.amount ?? 0,
      metadata: r.metadata ?? {},
    }));
  }

  return {
    applicationFeeId,
    applicationFeeCents: charge?.application_fee_amount ?? 0,
    chargeAmountCents: charge?.amount ?? 0,
    // Direct: Stripe's fee hit the OPERATOR, not us. Never subtract it.
    stripeFeeCents: chargeAccountId ? 0 : (bt?.fee ?? 0),
    recordedUpliftCents: readRecordedUplift(piMetadata),
    alreadyRefundedFeeCents,
    feeRefunds,
  };
}
