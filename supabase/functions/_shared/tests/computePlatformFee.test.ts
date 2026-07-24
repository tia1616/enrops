// Tests for computePlatformFee. Pure-function tests; no Supabase or Stripe.
// Run: deno test supabase/functions/_shared/tests/computePlatformFee.test.ts

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { computePlatformFee, PlatformFeeConfig } from '../computePlatformFee.ts';

const FREE_TIER: PlatformFeeConfig = {
  platform_fee_card_pct: 0.02,
  platform_fee_ach_pct: 0.005,
  platform_fee_cap_cents: 500,
};

Deno.test('$275 card hits the $5 cap (free tier)', () => {
  assertEquals(computePlatformFee(27500, 'card', FREE_TIER), 500);
});

Deno.test('$200 card is below cap (2% = $4.00)', () => {
  assertEquals(computePlatformFee(20000, 'card', FREE_TIER), 400);
});

Deno.test('$250 card is exactly at cap', () => {
  assertEquals(computePlatformFee(25000, 'card', FREE_TIER), 500);
});

Deno.test('$100 ACH uses ACH rate (0.5% = $0.50)', () => {
  assertEquals(computePlatformFee(10000, 'us_bank_account', FREE_TIER), 50);
});

Deno.test('zero amount returns 0', () => {
  assertEquals(computePlatformFee(0, 'card', FREE_TIER), 0);
});

Deno.test('negative amount returns 0', () => {
  assertEquals(computePlatformFee(-100, 'card', FREE_TIER), 0);
});

Deno.test('$1 charge produces 2¢ fee (no rounding to 0)', () => {
  assertEquals(computePlatformFee(100, 'card', FREE_TIER), 2);
});

Deno.test('24¢ charge rounds 0.48¢ down to 0', () => {
  assertEquals(computePlatformFee(24, 'card', FREE_TIER), 0);
});

Deno.test('very large amount is still capped', () => {
  assertEquals(computePlatformFee(10_000_00, 'card', FREE_TIER), 500);
});

Deno.test('non-finite amount (NaN, Infinity) returns 0', () => {
  assertEquals(computePlatformFee(NaN, 'card', FREE_TIER), 0);
  assertEquals(computePlatformFee(Infinity, 'card', FREE_TIER), 0);
});

Deno.test('custom rate higher than free tier still respects cap', () => {
  const growthTier: PlatformFeeConfig = {
    platform_fee_card_pct: 0.04,
    platform_fee_ach_pct: 0.01,
    platform_fee_cap_cents: 1000,
  };
  // $200 * 4% = $8.00, under $10 cap
  assertEquals(computePlatformFee(20000, 'card', growthTier), 800);
  // $300 * 4% = $12.00, capped at $10
  assertEquals(computePlatformFee(30000, 'card', growthTier), 1000);
});

Deno.test('ACH and card rates are independent', () => {
  // $500 charge — card and ACH produce different fees
  const cardFee = computePlatformFee(50000, 'card', FREE_TIER);
  const achFee = computePlatformFee(50000, 'us_bank_account', FREE_TIER);
  assertEquals(cardFee, 500); // capped
  assertEquals(achFee, 250);  // 500 * 0.005 = 2.5
});

// --- Registration fee model: 3% / $1.99 floor / $7.99 cap (Arielle) ---
const REG_TIER: PlatformFeeConfig = {
  platform_fee_card_pct: 0.03,
  platform_fee_ach_pct: 0.03,
  platform_fee_cap_cents: 799,
  platform_fee_floor_cents: 199,
};

Deno.test('floor: $10 charge (3% = $0.30) is lifted to the $1.99 floor', () => {
  assertEquals(computePlatformFee(1000, 'card', REG_TIER), 199);
});

Deno.test('floor: $100 charge (3% = $3.00) sits above the floor, under the cap', () => {
  assertEquals(computePlatformFee(10000, 'card', REG_TIER), 300);
});

Deno.test('cap: $300 charge (3% = $9.00) is clamped to the $7.99 cap', () => {
  assertEquals(computePlatformFee(30000, 'card', REG_TIER), 799);
});

Deno.test('floor applies to ACH too (rate > 0)', () => {
  assertEquals(computePlatformFee(1000, 'us_bank_account', REG_TIER), 199);
});

Deno.test('a 0% rate never triggers the floor (no phantom fee)', () => {
  const noFee: PlatformFeeConfig = {
    platform_fee_card_pct: 0,
    platform_fee_ach_pct: 0,
    platform_fee_cap_cents: 799,
    platform_fee_floor_cents: 199,
  };
  assertEquals(computePlatformFee(5000, 'card', noFee), 0);
});

Deno.test('null floor = no floor (existing tenants unchanged)', () => {
  const noFloor: PlatformFeeConfig = {
    platform_fee_card_pct: 0.03,
    platform_fee_ach_pct: 0.03,
    platform_fee_cap_cents: 799,
    platform_fee_floor_cents: null,
  };
  assertEquals(computePlatformFee(1000, 'card', noFloor), 30); // 3% of $10, no lift
});
