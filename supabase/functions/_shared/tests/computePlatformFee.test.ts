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
