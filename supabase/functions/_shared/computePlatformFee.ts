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
// PER LINE, NOT PER CART. The floor and the cap belong to one registration.
// Handing this function a cart total collects one ceiling on a basket of six
// children, and one floor on a basket of three drop-ins. Use _shared/cartFee.ts
// for anything that has more than one registration in its hands - it is the
// only caller shape that can get this right, and it is what section 4 of the
// money layer requires.
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
  platform_fee_cap_cents?: number | null;   // max fee per LINE; null/absent/0 = no cap
  platform_fee_floor_cents?: number | null; // min fee per LINE; null/absent = no floor
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

  // A null/absent/zero cap means NO cap, matching how the floor above treats a
  // null and matching src/lib/platformFee.js, which has always read it that way.
  //
  // FIXED 2026-09-18. This line used to be Math.min(computed, cap) with the raw
  // column value, and `Math.min(x, null)` coerces null to 0 - so an org with no
  // cap configured charged NO FEE from the server while the family-facing
  // helper, reading the same column as Infinity, displayed one. Two numbers,
  // one config row. Nothing on prod has a null cap today, which is the only
  // reason this never surfaced; the new pricing writes these columns, so it
  // would have.
  const rawCap = org.platform_fee_cap_cents;
  const cap =
    Number.isFinite(rawCap as number) && (rawCap as number) > 0
      ? (rawCap as number)
      : Infinity;

  const computed = Math.round(amountCents * rate);
  return Math.min(Math.max(computed, floor), cap);
}
