// estimateStripeFee — estimates Stripe's processing fee (in cents) for a charge,
// so it can be recovered from the connected account on destination charges.
//
// WHY: On a Stripe destination charge, Stripe debits its processing fee from the
// PLATFORM (Enrops) balance by default. To make the PROVIDER bear it — the Enrops
// fee model: the provider absorbs processing (exactly like Square / Squarespace /
// Stripe already do for them), and Enrops nets a clean 1% — buildConnectChargeParams
// adds this estimate to application_fee_amount when organizations.stripe_fee_payer
// = 'tenant'.
//
// This is an ESTIMATE. Stripe's ACTUAL fee lives on the balance transaction and may
// differ by ~1¢ (rounding) and is higher for international cards (+~1.5%). We
// deliberately accept slight UNDER-recovery on intl cards rather than over-charge a
// provider. The actual fee is always reconciled by Stripe / the accounting connector.
//
// IMPORTANT: this is intentionally SEPARATE from computePlatformFee (the 1% margin).
// computePlatformFee is shared with the family-facing pass-through line item; the
// Stripe-fee uplift must NEVER leak into what families are charged. Keep them apart.
//
// Rates below are Stripe US STANDARD pricing. They are the single source for fee
// recovery across create-checkout and process-installments. If Stripe changes its
// pricing, or the platform negotiates custom rates, update these constants.

import { PaymentMethodType } from './computePlatformFee.ts';

// Stripe US standard pricing.
export const STRIPE_CARD_PCT = 0.029; // 2.9%
export const STRIPE_CARD_FIXED_CENTS = 30; // + 30¢ per successful card charge
export const STRIPE_ACH_PCT = 0.008; // 0.8%
export const STRIPE_ACH_CAP_CENTS = 500; // capped at $5.00, no fixed fee

export function estimateStripeFee(
  amountCents: number,
  paymentMethodType: PaymentMethodType,
): number {
  // No charge → no fee (refunds, errors, edge cases).
  if (!Number.isFinite(amountCents) || amountCents <= 0) return 0;

  if (paymentMethodType === 'us_bank_account') {
    // ACH: percentage capped at $5, no fixed component.
    return Math.min(Math.round(amountCents * STRIPE_ACH_PCT), STRIPE_ACH_CAP_CENTS);
  }

  // Card (default): percentage + fixed, no cap.
  return Math.round(amountCents * STRIPE_CARD_PCT) + STRIPE_CARD_FIXED_CENTS;
}
