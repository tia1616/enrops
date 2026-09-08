// Server half of the gift arithmetic. The numeric cases here are deliberately
// the SAME ones src/lib/scholarshipFund.test.mjs pins in the browser: if these
// two files ever disagree, a family is shown one figure and charged another.

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import {
  coverFeeCents,
  validateGift,
  scholarshipLineItem,
  ScholarshipFundConfig,
} from '../scholarshipFund.ts';

const CFG: ScholarshipFundConfig = {
  enabled: true,
  headline: 'Help another family join',
  blurb: 'blurb',
  tax_note: 'Donations are not tax-deductible. Every dollar goes to the scholarship fund.',
  preset_amounts_cents: [500, 1000, 2500, 5000],
  min_cents: 100,
  max_cents: 500000,
  cover_fee_default: true,
  cover_fee_pct: 0.029,
};

Deno.test('cover fee is the configured percentage and nothing else', () => {
  // No flat 30c: the gift rides on a charge that already paid it once.
  assertEquals(coverFeeCents(500, true, CFG), 15);
  assertEquals(coverFeeCents(1000, true, CFG), 29);
  assertEquals(coverFeeCents(2500, true, CFG), 73);
  assertEquals(coverFeeCents(5000, true, CFG), 145);
});

Deno.test('cover fee is zero when declined, zero-rated or absent', () => {
  assertEquals(coverFeeCents(2500, false, CFG), 0);
  assertEquals(coverFeeCents(2500, true, { cover_fee_pct: 0 }), 0);
  assertEquals(coverFeeCents(0, true, CFG), 0);
  assertEquals(coverFeeCents(-100, true, CFG), 0);
});

Deno.test('no gift is accepted, not refused', () => {
  for (const empty of [null, undefined, 0]) {
    const v = validateGift(empty, true, CFG);
    assertEquals(v.ok, true);
    assertEquals(v.chargedCents, 0);
  }
});

Deno.test('a valid gift computes its own cover and total', () => {
  const v = validateGift(2500, true, CFG);
  assertEquals(v.ok, true);
  assertEquals(v.giftCents, 2500);
  assertEquals(v.coveredFeeCents, 73);
  assertEquals(v.chargedCents, 2573);
});

Deno.test('declining the cover charges exactly the gift', () => {
  const v = validateGift(2500, false, CFG);
  assertEquals(v.chargedCents, 2500);
  assertEquals(v.coveredFeeCents, 0);
});

// THE REGRESSION THAT MATTERS: an earlier draft spread the zero-result AFTER
// setting ok:false, so its own ok:true won and every refusal below came back as
// an accept. The charge would have been 0 - no money lost - but a tampered or
// out-of-bounds amount would have sailed through the gate silently instead of
// being refused and logged.
Deno.test('every refusal actually reports ok:false', () => {
  const refusals: Array<[string, unknown, ScholarshipFundConfig | null]> = [
    ['below the minimum', 99, CFG],
    ['above the maximum', 500001, CFG],
    ['fractional cents', 100.5, CFG],
    ['not a number', 'lots', CFG],
    ['negative', -500, CFG],
    ['fund switched off', 2500, { ...CFG, enabled: false }],
    ['no config at all', 2500, null],
  ];
  for (const [name, amount, cfg] of refusals) {
    const v = validateGift(amount, true, cfg);
    assertEquals(v.ok, false, `${name} should be refused`);
    assertEquals(v.chargedCents, 0, `${name} should charge nothing`);
    assertEquals(typeof v.reason, 'string', `${name} should say why`);
  }
});

Deno.test('bounds are inclusive at both ends', () => {
  assertEquals(validateGift(100, false, CFG).ok, true);
  assertEquals(validateGift(500000, false, CFG).ok, true);
});

Deno.test('a refused gift produces no Stripe line', () => {
  assertEquals(scholarshipLineItem(validateGift(500001, true, CFG), 'Journey to STEAM'), null);
  assertEquals(scholarshipLineItem(validateGift(0, true, CFG), 'Journey to STEAM'), null);
});

Deno.test('the Stripe line is ONE line carrying gift plus cover', () => {
  // Not two lines. A separate fee line on a card charge reads as a surcharge,
  // which is what passThroughFee.ts is careful to avoid for the same reason.
  const line = scholarshipLineItem(validateGift(2500, true, CFG), 'Journey to STEAM');
  assertEquals(line?.price_data.unit_amount, 2573);
  assertEquals(line?.quantity, 1);
  assertEquals(line?.price_data.product_data.name, 'Scholarship fund donation');
  // The description has to account for the 73c, or the family sees $25.73 next
  // to the word "donation" for a $25 gift and cannot tell where the change went.
  assertEquals(line?.price_data.product_data.description.includes('$25.00'), true);
  assertEquals(line?.price_data.product_data.description.includes('$0.73'), true);
});

Deno.test('without a cover the line names only the gift', () => {
  const line = scholarshipLineItem(validateGift(2500, false, CFG), 'Journey to STEAM');
  assertEquals(line?.price_data.unit_amount, 2500);
  assertEquals(line?.price_data.product_data.description.includes('Journey to STEAM'), true);
});
