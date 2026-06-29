// Tests for estimateStripeFee. Pure-function tests; no Supabase or Stripe.
// Run: deno test supabase/functions/_shared/tests/estimateStripeFee.test.ts

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { estimateStripeFee } from '../estimateStripeFee.ts';

// --- Card: 2.9% + 30¢, no cap ---

Deno.test('$200 card → $6.10 (2.9% of 200 = $5.80 + $0.30)', () => {
  assertEquals(estimateStripeFee(20000, 'card'), 610);
});

Deno.test('$100 card → $3.20 ($2.90 + $0.30)', () => {
  assertEquals(estimateStripeFee(10000, 'card'), 320);
});

Deno.test('$1 card → 33¢ (3¢ + 30¢; the 30¢ fixed always applies)', () => {
  assertEquals(estimateStripeFee(100, 'card'), 33);
});

Deno.test('large $10,000 card has NO cap → $290.30', () => {
  assertEquals(estimateStripeFee(1_000_000, 'card'), 29030);
});

// --- ACH (us_bank_account): 0.8% capped at $5, no fixed fee ---

Deno.test('$200 ACH → $1.60 (0.8%, under cap, no fixed fee)', () => {
  assertEquals(estimateStripeFee(20000, 'us_bank_account'), 160);
});

Deno.test('$625 ACH → exactly at the $5 cap', () => {
  assertEquals(estimateStripeFee(62500, 'us_bank_account'), 500);
});

Deno.test('$1000 ACH → capped at $5 (would be $8 uncapped)', () => {
  assertEquals(estimateStripeFee(100000, 'us_bank_account'), 500);
});

// --- Edge cases ---

Deno.test('zero amount returns 0 (no charge, no fee)', () => {
  assertEquals(estimateStripeFee(0, 'card'), 0);
  assertEquals(estimateStripeFee(0, 'us_bank_account'), 0);
});

Deno.test('negative amount returns 0', () => {
  assertEquals(estimateStripeFee(-100, 'card'), 0);
});

Deno.test('non-finite amount (NaN, Infinity) returns 0', () => {
  assertEquals(estimateStripeFee(NaN, 'card'), 0);
  assertEquals(estimateStripeFee(Infinity, 'card'), 0);
});

// --- The numbers that matter: full picture on a $200 card registration ---
// Provider nets price − Stripe fee − Enrops 1%. This test documents the model:
//   parent pays $200 → Stripe $6.10 → Enrops $2.00 → provider nets $191.90.
// (Enrops 1% is computePlatformFee's job; here we lock the Stripe-fee half.)
Deno.test('$200 card: Stripe-fee half of the model = $6.10', () => {
  const stripeFee = estimateStripeFee(20000, 'card');
  const enropsFee = 200; // 1% of $200, for documentation
  const providerNets = 20000 - stripeFee - enropsFee;
  assertEquals(stripeFee, 610);
  assertEquals(providerNets, 19190); // $191.90
});
