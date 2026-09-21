// advertisedPrice — what a marketing email is allowed to quote.

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { advertisedPriceCents, advertisedPriceLabel, advertisedSavingLabel } from '../advertisedPrice.ts';

// J2S on production: absorbs the fee. Its copy must not change by a character.
const ABSORB = {
  fee_pass_through: false,
  platform_fee_card_pct: 0.01,
  platform_fee_ach_pct: 0.01,
  platform_fee_floor_cents: null,
  platform_fee_cap_cents: 2147483647,
};

// A pass-through org on the old 1% terms - Jeff today.
const PASS_1PCT = { ...ABSORB, fee_pass_through: true };

// The money layer's target pricing.
const PASS_NEW = {
  fee_pass_through: true,
  platform_fee_card_pct: 0.03,
  platform_fee_ach_pct: 0.02,
  platform_fee_floor_cents: 199,
  platform_fee_cap_cents: 1499,
  platform_fee_ach_cap_cents: 999,
};

// ── the absorb org must be byte-identical ─────────────────────────────────

Deno.test('absorb: the advertised price is the price typed, and stays whole dollars', () => {
  // This is J2S. Every marketing email they have ever sent says "$240", and
  // nothing about this change may alter that.
  assertEquals(advertisedPriceLabel(24000, ABSORB), '$240');
  assertEquals(advertisedPriceLabel(29900, ABSORB), '$299');
  assertEquals(advertisedPriceCents(24000, ABSORB), 24000);
});

Deno.test('absorb: a saving is still the plain difference', () => {
  assertEquals(advertisedSavingLabel(29900, 24000, ABSORB), '$59');
});

// ── pass-through: the all-in price ────────────────────────────────────────

Deno.test('pass-through: the advertised price includes the fee', () => {
  assertEquals(advertisedPriceLabel(24000, PASS_1PCT), '$242.40');
  assertEquals(advertisedPriceLabel(24000, PASS_NEW), '$247.20');
});

Deno.test("section 4's worked prices, as a marketing email would print them", () => {
  assertEquals(advertisedPriceLabel(2500, PASS_NEW), '$26.99');   // minimum
  assertEquals(advertisedPriceLabel(4500, PASS_NEW), '$46.99');   // minimum
  assertEquals(advertisedPriceLabel(8000, PASS_NEW), '$82.40');
  assertEquals(advertisedPriceLabel(24000, PASS_NEW), '$247.20');
  assertEquals(advertisedPriceLabel(29900, PASS_NEW), '$307.97');
  assertEquals(advertisedPriceLabel(60000, PASS_NEW), '$614.99'); // ceiling
  assertEquals(advertisedPriceLabel(120000, PASS_NEW), '$1214.99'); // ceiling
});

Deno.test('whole dollars stay whole even when a fee applies', () => {
  // A $100 class at 3% is $103.00 exactly - printing "$103.00" where the rest
  // of the copy says "$240" would look like a different kind of number.
  assertEquals(advertisedPriceLabel(10000, PASS_NEW), '$103');
});

// ── the saving, compared like for like ────────────────────────────────────

Deno.test('THE TRAP: a saving is all-in against all-in, never mixed', () => {
  // $299 regular, $240 early bird, 3% pass-through.
  // Regular all-in $307.97, early-bird all-in $247.20, so the saving is $60.77.
  assertEquals(advertisedSavingLabel(29900, 24000, PASS_NEW), '$60.77');

  // What mixing them would have produced, asserted so the difference is on the
  // record: all-in regular minus BARE early bird overstates it by the fee.
  const mixedAndWrong = (30797 - 24000) / 100;
  assertEquals(mixedAndWrong, 67.97);
  // The listing's VIP badge made exactly this mistake before it was caught.
});

Deno.test('no saving to claim means an empty string, not "$0"', () => {
  assertEquals(advertisedSavingLabel(24000, 24000, PASS_NEW), '');
  assertEquals(advertisedSavingLabel(24000, 29900, PASS_NEW), ''); // "discount" is dearer
  assertEquals(advertisedSavingLabel(null, 24000, PASS_NEW), '');
  assertEquals(advertisedSavingLabel(24000, null, PASS_NEW), '');
});

// ── the empty cases, which decide whether a price line appears at all ─────

Deno.test('a missing or zero price renders nothing, so the copy omits the line', () => {
  // Partner-run camps keep price_cents null on purpose. A "$0" in a marketing
  // email is worse than no price at all.
  for (const bad of [null, undefined, 0, -100, NaN]) {
    assertEquals(advertisedPriceLabel(bad as number | null, PASS_NEW), '', String(bad));
  }
});

Deno.test('a null org config is treated as no fee, never as a crash', () => {
  // The send must not fail because a settings read came back empty; it falls
  // back to the base price, which is the operator's own number.
  assertEquals(advertisedPriceLabel(24000, null), '$240');
  assertEquals(advertisedPriceLabel(24000, undefined), '$240');
});

// ── card, not bank ────────────────────────────────────────────────────────

Deno.test('advertised means CARD: the bank price is a discount shown later', () => {
  // Quoting the cheaper bank price in an advert and charging the card price is
  // the shape that gets called a surcharge.
  assertEquals(advertisedPriceLabel(24000, PASS_NEW), '$247.20');
  assertEquals(advertisedPriceLabel(24000, PASS_NEW, 'us_bank_account'), '$244.80');
  // and the default is card, asserted rather than assumed
  assertEquals(
    advertisedPriceLabel(24000, PASS_NEW),
    advertisedPriceLabel(24000, PASS_NEW, 'card'),
  );
});
