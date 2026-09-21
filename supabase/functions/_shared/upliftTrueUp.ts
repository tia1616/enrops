// upliftTrueUp - give back the part of the Stripe-fee uplift we over-recovered.
//
// THE DEFECT. On a destination charge with stripe_fee_payer='tenant', the
// application fee is `margin + estimateStripeFee(...)` (see connectChargeParams).
// That fee is set when the Checkout Session is CREATED, which is before the
// family has chosen how to pay inside Stripe - so the rail cannot be known, and
// estimateStripeFee quotes the card rate, 2.9% + 30c.
//
// Stripe does not bill every card-shaped rail at that rate. A Link payment
// funded by a BANK ACCOUNT is billed 2.6% + 30c while still reporting
// payment_method_details.type = 'card'. Whenever that happens, the uplift
// recovered more from the provider than Stripe actually took from us.
//
// Measured on production 2026-09-21, over the last 100 live platform charges:
// 99 destination charges carrying a fee, 7 of them billed below the estimate,
// $5.36 over-recovered in total. Every one was Link-funded-by-bank. Nothing was
// wrong in the other direction. (Link used as a WALLET over a card - 65 of the
// 99 - is billed at card rates and was already correct.)
//
// THE FIX IS DELIBERATELY NOT ABOUT LINK. Nothing here knows what Link is. We
// compare the uplift we recovered against the fee Stripe really took, and hand
// back the difference. Any rail Stripe prices below the card rate - today's, or
// one introduced next year - corrects itself with no code change.
//
// THE UPLIFT IS READ, NOT REBUILT, and getting that wrong was a real bug caught
// in review. The first version recomputed estimateStripeFee from the charge
// total. That is not the same number: the uplift is sized on the registration
// total, while the charge Stripe bills ALSO carries the pass-through fee line
// when the provider passes the fee on to families. Rebuilding it from the
// charge therefore overstates the uplift, and the difference comes out of
// Enrops's margin - about 26c on a $300 registration at a 3% pass-through. It
// was dormant on production only because the one connected destination org does
// not pass the fee on, and it would have armed itself on the day that flipped.
//
// So buildChargeRouting now reports the uplift it actually put in the fee, and
// every caller writes it onto the charge as `enrops_uplift_cents`. A charge
// with no such metadata is left alone: predating the change is not a reason to
// guess. Measured off the charge is a guess; written down at creation is a fact.
//
// ONE DIRECTION ONLY. When Stripe's real fee is HIGHER than the estimate (an
// international card, say), we absorb it and take nothing more. That is the
// standing policy stated in estimateStripeFee's own header: under-recover
// rather than over-charge a provider. A true-up that clawed money BACK from a
// provider after the fact would be a different product decision, and is not
// this one.
//
// COMPOSES WITH THE REFUND PATH, WHICH NEEDS NO CHANGE. refundFeeSplit computes
// `marginTotal = applicationFee - REAL stripe fee`, so on a Link charge it
// already treats the over-recovery as refundable margin. Once we have handed it
// back here it shows up in `alreadyRefundedFeeCents`, and refundFeeSplit's
// `marginRemaining = marginTotal - alreadyRefunded` subtracts it right back out.
// A true-up followed by a full refund returns exactly the margin, never twice.
//
// THE OTHER ORDER NEEDED A GUARD, and code review is what found it. When the
// REFUND lands first, its fee refund already contains the over-recovery, and
// nothing in the arithmetic above would stop us paying the same cents again on
// a late webhook delivery - Stripe redelivers a failed event for up to three
// days, which is ample time for a family to cancel. So any pre-existing fee
// refund that is not our own tag means the refund path got here first, and the
// true-up stands down. Both orders asserted in tests/upliftTrueUp.test.ts.

import { ChargeFeeFacts, readChargeFeeFacts } from './chargeFeeFacts.ts';

/** Metadata key tagging a fee refund as an uplift true-up, for idempotency. */
export const UPLIFT_TRUEUP_KEY = 'enrops_uplift_trueup';

/**
 * PaymentIntent metadata key carrying the uplift that went into the
 * application fee, written at charge creation by every caller of
 * buildChargeRouting. See THE UPLIFT IS READ, NOT REBUILT in the header.
 *
 * Re-exported from chargeFeeFacts, which is where it is READ, so that writers
 * and reader can never drift apart.
 */
export { UPLIFT_METADATA_KEY } from './chargeFeeFacts.ts';

export interface UpliftTrueUpInput {
  /**
   * The uplift that actually went into the application fee, in cents, as
   * recorded on the charge at creation. Never recomputed - see the header.
   */
  recordedUpliftCents: number | null;
  /** Stripe's real fee from the balance transaction, in cents. */
  actualStripeFeeCents: number;
  /** application_fee_amount actually taken on the charge, in cents. */
  applicationFeeCents: number;
  /** Application fee already refunded, in cents. */
  alreadyRefundedFeeCents?: number;
}

/**
 * Cents of the application fee to hand back to the provider. 0 means do nothing.
 *
 * Returns 0 in every case it cannot prove is a genuine over-recovery, because
 * the failure directions are not symmetric: handing back too little leaves a
 * few cents of a known, bounded debt, while handing back money that was never
 * uplift comes straight out of Enrops's margin.
 */
export function upliftOverRecoveryCents(input: UpliftTrueUpInput): number {
  const {
    recordedUpliftCents,
    actualStripeFeeCents,
    applicationFeeCents,
    alreadyRefundedFeeCents = 0,
  } = input;

  // NO RECORDED UPLIFT, NO TRUE-UP. Either this charge predates the metadata
  // (nothing to reconcile that a refund will not handle anyway) or it carried
  // no uplift at all. Guessing one from the charge amount is the defect this
  // design exists to remove.
  if (recordedUpliftCents === null) return 0;

  // Unusable numbers do nothing at all. NaN comparisons are all false, so a bad
  // input would otherwise slip past the guards below as a silent 0 anyway - but
  // being explicit is what makes that a decision rather than an accident.
  for (const n of [recordedUpliftCents, actualStripeFeeCents, applicationFeeCents, alreadyRefundedFeeCents]) {
    if (!Number.isFinite(n)) return 0;
  }
  if (!(recordedUpliftCents > 0)) return 0;

  // GUARD 1 - DESTINATION ONLY. On a direct charge Stripe's fee comes out of
  // the OPERATOR's balance, readChargeFeeFacts reports it as 0, and the
  // application fee is clean margin with no uplift in it. Without this line a
  // direct charge would compute `estimate - 0` and refund the entire estimate
  // out of margin. The caller already checks the charge model; this is the
  // second lock, and it fails closed.
  if (!(actualStripeFeeCents > 0)) return 0;

  // No fee taken means nothing to give back.
  if (!(applicationFeeCents > 0)) return 0;

  // GUARD 2 - THE FEE MUST BE BIG ENOUGH TO CONTAIN THE UPLIFT. The fee is
  // `margin + uplift` and margin is never negative, so this always holds for a
  // charge whose metadata belongs to it. When it does not, the two numbers
  // disagree about the same charge and anything returned would be margin.
  if (applicationFeeCents < recordedUpliftCents) return 0;

  // The over-recovery itself. Not an over-recovery if Stripe charged us at or
  // above what we recovered: see ONE DIRECTION ONLY in the header.
  const excess = recordedUpliftCents - actualStripeFeeCents;
  if (!(excess > 0)) return 0;

  // Never refund more of the fee than is left. Stripe rejects a fee refund that
  // exceeds the fee, which would fail the whole call rather than clamp.
  const feeRemaining = applicationFeeCents - Math.max(0, alreadyRefundedFeeCents);

  return Math.max(0, Math.min(excess, feeRemaining));
}

/**
 * The true-up we already issued for this charge, if any.
 *
 * Asks Stripe rather than inferring from our own tables, for the same reason
 * the refund path does: issuing the refund and recording it are two writes
 * against two systems, and only Stripe can settle whether the money moved.
 */
export function findExistingTrueUp(
  feeRefunds: Array<{ id: string; amount: number; metadata: Record<string, string> }>,
  paymentIntentId: string,
): { id: string; amount: number } | null {
  const hit = feeRefunds.find((fr) => fr.metadata[UPLIFT_TRUEUP_KEY] === paymentIntentId);
  return hit ? { id: hit.id, amount: hit.amount } : null;
}

interface TrueUpStripe {
  paymentIntents: { retrieve(id: string, params?: unknown, options?: unknown): Promise<unknown> };
  applicationFees: {
    retrieve(id: string, params?: unknown, options?: unknown): Promise<unknown>;
    createRefund(
      id: string,
      params?: unknown,
      options?: unknown,
    ): Promise<{ amount?: number }>;
  };
}

export interface TrueUpResult {
  /** Cents handed back to the provider on this call. 0 means nothing moved. */
  returnedCents: number;
  /** Why, in words, for the log line. */
  reason: string;
}

/**
 * Run the true-up for one settled charge. NEVER THROWS.
 *
 * Every caller sits on the path that has just taken a family's money and is
 * about to confirm their registration. A processing-fee true-up of a few cents
 * must not be able to fail that: a throw here would fail the webhook, Stripe
 * would redeliver, and the family would get a second confirmation email over
 * $0.86. So every failure is logged and swallowed, and the fallback is the
 * status quo ante - the provider is out the same few cents they were out
 * before this existed, and refundFeeSplit still returns it in full if the
 * registration is ever refunded.
 *
 * @param chargeAccountId the account the charge was created on; null = platform
 *                        (a destination charge, the only model with an uplift).
 * @param orgBearsStripeFee organizations.stripe_fee_payer === 'tenant'.
 */
export async function runUpliftTrueUp(
  stripe: TrueUpStripe,
  opts: {
    paymentIntentId: string;
    chargeAccountId: string | null;
    orgBearsStripeFee: boolean;
    label?: string;
  },
): Promise<TrueUpResult> {
  const { paymentIntentId, chargeAccountId, orgBearsStripeFee } = opts;
  const tag = `[uplift-trueup]${opts.label ? ' ' + opts.label : ''}`;

  if (!paymentIntentId) return { returnedCents: 0, reason: 'no payment intent' };
  // A direct charge carries no uplift at all: Stripe billed the operator, and
  // the application fee is clean margin. Nothing to true up, and reading the
  // charge to find that out would be a wasted round trip on every direct
  // charge on the platform.
  if (chargeAccountId) return { returnedCents: 0, reason: 'direct charge, no uplift' };
  // Likewise when the org absorbs processing: the fee is margin only.
  if (!orgBearsStripeFee) return { returnedCents: 0, reason: 'org absorbs processing' };

  try {
    let facts: ChargeFeeFacts;
    try {
      facts = await readChargeFeeFacts(stripe, paymentIntentId, null);
    } catch (err) {
      // Includes the ordinary ACH case: checkout.session.completed fires days
      // before the debit clears, so there is no balance transaction to read
      // yet. async_payment_succeeded comes back through here when there is.
      console.warn(`${tag} could not read ${paymentIntentId}:`, err);
      return { returnedCents: 0, reason: 'charge not readable yet' };
    }

    if (!facts.applicationFeeId) return { returnedCents: 0, reason: 'no application fee' };

    // No recorded uplift means this charge predates the metadata, or carried no
    // uplift. Either way there is nothing here that can be reconciled honestly.
    if (facts.recordedUpliftCents === null) {
      console.log(`${tag} ${paymentIntentId}: no recorded uplift, nothing to true up`);
      return { returnedCents: 0, reason: 'no recorded uplift' };
    }

    // ALREADY DONE? Ask Stripe, never infer. Two webhook endpoints currently
    // point at this same function, so every event arrives twice; this is what
    // makes the second delivery a no-op instead of a second refund.
    const existing = findExistingTrueUp(facts.feeRefunds, paymentIntentId);
    if (existing) {
      console.log(`${tag} ${paymentIntentId} already trued up (${existing.amount}c)`);
      return { returnedCents: existing.amount, reason: 'already trued up' };
    }

    // A REFUND ALREADY GAVE IT BACK. refundFeeSplit computes the refundable
    // margin as `applicationFee - REAL stripe fee`, so the over-recovery is
    // inside every fee refund it issues. If any fee refund exists and none of
    // them is ours, the refund path got here first and truing up now would
    // return the same cents twice.
    //
    // Reachable: Stripe redelivers a failed checkout.session.completed for up
    // to three days, which is ample time for a family to cancel. Ordering is
    // not guaranteed, so this cannot be reasoned away by "the charge comes
    // first".
    if (facts.alreadyRefundedFeeCents > 0) {
      console.log(
        `${tag} ${paymentIntentId}: ${facts.alreadyRefundedFeeCents}c of the fee was already refunded, which includes the over-recovery; not truing up`,
      );
      return { returnedCents: 0, reason: 'already returned by a refund' };
    }

    const owed = upliftOverRecoveryCents({
      recordedUpliftCents: facts.recordedUpliftCents,
      actualStripeFeeCents: facts.stripeFeeCents,
      applicationFeeCents: facts.applicationFeeCents,
      alreadyRefundedFeeCents: facts.alreadyRefundedFeeCents,
    });

    if (owed <= 0) return { returnedCents: 0, reason: 'we recovered no more than Stripe took' };

    const refund = await stripe.applicationFees.createRefund(
      facts.applicationFeeId,
      { amount: owed, metadata: { [UPLIFT_TRUEUP_KEY]: paymentIntentId } },
      { idempotencyKey: `uplift_${paymentIntentId}` },
    );
    const returned = refund.amount ?? owed;
    console.log(
      `${tag} ${paymentIntentId}: recovered ${facts.recordedUpliftCents}c, Stripe took ${facts.stripeFeeCents}c, returned ${returned}c to the provider`,
    );
    return { returnedCents: returned, reason: 'trued up' };
  } catch (err) {
    // See NEVER THROWS above. Loud, because a run of these means the uplift is
    // wrong in a way the estimate should be fixed for, not papered over.
    console.error(`${tag} FAILED for ${paymentIntentId}:`, err);
    return { returnedCents: 0, reason: 'failed' };
  }
}

/**
 * runUpliftTrueUp with the who-pays question answered from the org row.
 *
 * Exists so a caller that has an organization id but no fee config cannot
 * accidentally pass `orgBearsStripeFee: true` and hand back margin. Also never
 * throws: a lookup that fails is treated as "we cannot prove there is an
 * uplift", which is the safe direction.
 */
export async function runUpliftTrueUpForOrg(
  admin: any,
  stripe: TrueUpStripe,
  opts: {
    organizationId: string | null | undefined;
    paymentIntentId: string;
    chargeAccountId: string | null;
    label?: string;
  },
): Promise<TrueUpResult> {
  if (!opts.organizationId) return { returnedCents: 0, reason: 'no organization' };
  try {
    const { data, error } = await admin
      .from('organizations')
      .select('stripe_fee_payer')
      .eq('id', opts.organizationId)
      .maybeSingle();
    if (error || !data) {
      console.warn('[uplift-trueup] could not read stripe_fee_payer:', error?.message ?? 'no row');
      return { returnedCents: 0, reason: 'fee payer unknown' };
    }
    return await runUpliftTrueUp(stripe, {
      paymentIntentId: opts.paymentIntentId,
      chargeAccountId: opts.chargeAccountId,
      orgBearsStripeFee: data.stripe_fee_payer === 'tenant',
      label: opts.label,
    });
  } catch (err) {
    console.error('[uplift-trueup] org lookup threw:', err);
    return { returnedCents: 0, reason: 'failed' };
  }
}
