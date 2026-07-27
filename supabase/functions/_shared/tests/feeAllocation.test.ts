// Tests for allocateFeeAcrossInstallments — the platform fee is capped per
// REGISTRATION, so it is computed once on the total and split across charges.
//
// Run: deno test supabase/functions/_shared/tests/feeAllocation.test.ts

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { allocateFeeAcrossInstallments } from '../feeAllocation.ts';
import { computePlatformFee, PlatformFeeConfig } from '../computePlatformFee.ts';

// The registration fee model: 3% / $1.99 floor / $7.99 cap.
const REG: PlatformFeeConfig = {
  platform_fee_card_pct: 0.03,
  platform_fee_ach_pct: 0.03,
  platform_fee_cap_cents: 799,
  platform_fee_floor_cents: 199,
};

// J2S: 1%, no floor, effectively uncapped.
const J2S: PlatformFeeConfig = {
  platform_fee_card_pct: 0.01,
  platform_fee_ach_pct: 0.01,
  platform_fee_cap_cents: 2147483647,
};

const splitEvenly = (total: number) => [
  Math.floor(total / 3) + (total - Math.floor(total / 3) * 3),
  Math.floor(total / 3),
  Math.floor(total / 3),
];

Deno.test('shares always sum EXACTLY to the fee (no drift, no lost cent)', () => {
  for (const fee of [0, 1, 2, 5, 199, 720, 799, 1000, 12345]) {
    const shares = allocateFeeAcrossInstallments(fee, [8000, 8000, 8000]);
    assertEquals(shares.reduce((s, v) => s + v, 0), fee, `fee ${fee} must be fully allocated`);
  }
});

Deno.test('remainder lands on installment 1, never on an off-session charge', () => {
  // 100 / 3 = 33.33: charge 1 absorbs the extra cent, because charge 1 is the
  // one the family sees and consents to at checkout.
  assertEquals(allocateFeeAcrossInstallments(100, [8000, 8000, 8000]), [34, 33, 33]);
});

Deno.test('THE BUG THIS FIXES: $500 program no longer collects the cap 3x', () => {
  const total = 50000;
  const inFull = computePlatformFee(total, 'card', REG);
  assertEquals(inFull, 799); // 3% = $15.00, clamped to the $7.99 cap

  const perInstallment = Math.round(total / 3);
  const oldWay = computePlatformFee(perInstallment, 'card', REG) * 3;
  assertEquals(oldWay, 1500); // 3 x $5.00 — nearly double the cap

  const shares = allocateFeeAcrossInstallments(inFull, [perInstallment, perInstallment, total - 2 * perInstallment]);
  assertEquals(shares.reduce((s, v) => s + v, 0), 799); // now equals paying in full
});

Deno.test('below the cap nothing changes: $240 is $7.20 either way', () => {
  const total = 24000;
  const inFull = computePlatformFee(total, 'card', REG);
  assertEquals(inFull, 720);
  // What the per-charge code used to produce for the same schedule.
  assertEquals(computePlatformFee(8000, 'card', REG) * 3, 720);
  assertEquals(allocateFeeAcrossInstallments(inFull, [8000, 8000, 8000]), [240, 240, 240]);
});

Deno.test('J2S: uncapped 1% now matches pay-in-full exactly (was 1c under)', () => {
  const total = 27400;
  const inFull = computePlatformFee(total, 'card', J2S);
  assertEquals(inFull, 274);

  // The OLD per-charge behaviour: 1% of each third, each rounded separately.
  // 9134 -> 91, 9133 -> 91, 9133 -> 91 = 273. A cent short of the whole,
  // because three independent roundings lose it.
  const per = splitEvenly(total).map((a) => computePlatformFee(a, 'card', J2S));
  assertEquals(per.reduce((s, v) => s + v, 0), 273);

  // The new allocation rounds ONCE against the total, so a payment plan costs
  // precisely what paying up front costs. For an uncapped org like J2S that is
  // the entire difference: one cent, in the platform's favour, and no longer
  // dependent on how the schedule happens to divide.
  const shares = allocateFeeAcrossInstallments(inFull, splitEvenly(total));
  assertEquals(shares.reduce((s, v) => s + v, 0), 274);
});

Deno.test('FLOOR no longer multiplies: a floored fee is charged once, not 3x', () => {
  // $210 total. 3% = $6.30, above the $1.99 floor, under the $7.99 cap.
  const inFull = computePlatformFee(21000, 'card', REG);
  assertEquals(inFull, 630);
  assertEquals(allocateFeeAcrossInstallments(inFull, [7000, 7000, 7000]), [210, 210, 210]);
  // A tiny total where the FLOOR binds: charged once across the plan, not per charge.
  const tinyInFull = computePlatformFee(3000, 'card', REG); // 3% = 90 -> floored to 199
  assertEquals(tinyInFull, 199);
  const tinyShares = allocateFeeAcrossInstallments(tinyInFull, [1000, 1000, 1000]);
  assertEquals(tinyShares.reduce((s, v) => s + v, 0), 199); // not 597
});

Deno.test('lopsided schedule allocates proportionally', () => {
  // Charge 1 double the others: 799 split 50/25/25.
  const shares = allocateFeeAcrossInstallments(799, [20000, 10000, 10000]);
  assertEquals(shares.reduce((s, v) => s + v, 0), 799);
  assertEquals(shares[0] > shares[1], true);
  assertEquals(shares[1], shares[2]);
});

Deno.test('zero fee (org charges nothing) allocates zeros, not a stray cent', () => {
  assertEquals(allocateFeeAcrossInstallments(0, [8000, 8000, 8000]), [0, 0, 0]);
});

Deno.test('degenerate schedule of zeros puts the fee on charge 1 rather than dropping it', () => {
  assertEquals(allocateFeeAcrossInstallments(500, [0, 0, 0]), [500, 0, 0]);
});

Deno.test('empty schedule returns empty (no crash)', () => {
  assertEquals(allocateFeeAcrossInstallments(799, []), []);
});
