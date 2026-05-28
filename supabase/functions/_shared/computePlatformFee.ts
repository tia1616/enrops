// computePlatformFee — pure function that returns Stripe Connect
// application_fee_amount (in cents) for a given charge.
//
// Used by:
//   - create-checkout (Chunk 3): when creating the initial Checkout Session
//   - process-installments (Chunk 4): when off-session charging installments 2/3
//
// Reads live config from the organizations row (no snapshotting at charge
// time per v2 spec). If Enrops changes a tenant's rate mid-installment-plan,
// the remaining installments use the new rate.
//
// Math: round(amount × rate) capped at platform_fee_cap_cents.
// Returns 0 for non-positive amounts (refunds, errors, edge cases).

export type PaymentMethodType = 'card' | 'us_bank_account';

export interface PlatformFeeConfig {
  platform_fee_card_pct: number;     // fraction, e.g. 0.02 = 2%
  platform_fee_ach_pct: number;      // fraction, e.g. 0.005 = 0.5%
  platform_fee_cap_cents: number;    // max fee per transaction
}

export function computePlatformFee(
  amountCents: number,
  paymentMethodType: PaymentMethodType,
  org: PlatformFeeConfig,
): number {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return 0;

  const rate =
    paymentMethodType === 'card'
      ? org.platform_fee_card_pct
      : org.platform_fee_ach_pct;

  const computed = Math.round(amountCents * rate);
  return Math.min(computed, org.platform_fee_cap_cents);
}
