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
// Math: clamp(round(amount × rate), floor, cap).
//   floor = platform_fee_floor_cents (min fee per txn) — applied ONLY when a
//           percentage rate is configured (rate > 0), so a 0%-fee org never gets
//           a phantom floor charge. NULL/absent floor = 0 (no floor) — this keeps
//           existing tenants (floor unset) byte-for-byte unchanged.
//   cap   = platform_fee_cap_cents (max fee per txn) — always the hard ceiling.
// Returns 0 for non-positive amounts (refunds, errors, edge cases) and for orgs
// with no percentage fee configured.

export type PaymentMethodType = 'card' | 'us_bank_account';

export interface PlatformFeeConfig {
  platform_fee_card_pct: number;     // fraction, e.g. 0.03 = 3%
  platform_fee_ach_pct: number;      // fraction, e.g. 0.005 = 0.5%
  platform_fee_cap_cents: number;    // max fee per transaction
  platform_fee_floor_cents?: number | null; // min fee per transaction; null/absent = no floor
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

  // No percentage fee configured → no fee at all (and no floor).
  if (!Number.isFinite(rate) || rate <= 0) return 0;

  const rawFloor = org.platform_fee_floor_cents;
  const floor =
    Number.isFinite(rawFloor as number) && (rawFloor as number) > 0
      ? (rawFloor as number)
      : 0;

  const computed = Math.round(amountCents * rate);
  return Math.min(Math.max(computed, floor), org.platform_fee_cap_cents);
}
