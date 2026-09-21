// Money layer section 4, and the Terms it is written into:
//
//   "(v) No service fee is charged on donations, tips, gift add-ons, or
//    registrations with a price of $0."
//
// That is a promise made to every operator in the Terms and repeated in the
// pricing table, so it needs to be a thing the code CANNOT stop doing, not a
// thing it happens to do. Every rule below holds today; these tests exist so a
// later change to the fee, the cart, or the gift has to break a red test on its
// way to charging a family for a donation.
//
// The four cases are NOT symmetric and are pinned separately on purpose:
//   - $0 lines are an arithmetic property of computePlatformFee (the floor must
//     not manufacture a fee out of nothing).
//   - donations and gift add-ons are a STRUCTURAL property: the gift never
//     reaches the fee base at all.
//   - tips do not exist in the product yet, which is pinned so that adding them
//     is a deliberate act rather than a silent inheritance of the fee.

import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { computePlatformFee } from '../computePlatformFee.ts';
import { cartFeeCents, feePerLine } from '../cartFee.ts';
import { receiptFeeCents } from '../receiptFee.ts';
import { validateGift } from '../scholarshipFund.ts';
import { advertisedPriceCents, advertisedPriceLabel } from '../advertisedPrice.ts';

/** The new pricing, as section 4 states it. Floor and both ceilings present. */
const ORG = {
  platform_fee_card_pct: 0.03,
  platform_fee_ach_pct: 0.02,
  platform_fee_cap_cents: 1499,
  platform_fee_ach_cap_cents: 999,
  platform_fee_floor_cents: 199,
};

const FUND = {
  enabled: true,
  headline: 'Help open the door',
  blurb: '',
  tax_note: '',
  preset_amounts_cents: [500, 1000, 2500, 5000],
  min_cents: 100,
  max_cents: 100000,
  cover_fee_default: false,
  cover_fee_pct: 0.029,
};

// ---------------------------------------------------------------------------
// "$0 registrations" - the floor must not invent a fee.
// ---------------------------------------------------------------------------

Deno.test('a $0 registration owes NOTHING, even with a $1.99 floor configured', () => {
  // The floor is the trap here: clamp(round(0 * 0.03), 199, 1499) would be 199.
  // A comped child would be charged $1.99 to enrol in a free class.
  for (const method of ['card', 'us_bank_account'] as const) {
    assertEquals(computePlatformFee(0, method, ORG), 0, method);
  }
});

Deno.test('a $0 line inside a PAID cart still owes nothing, and the others are unaffected', () => {
  // The mixed cart is the case a whole-cart check would miss: one child at
  // $299, a sibling on a full scholarship. The cart total is not zero, so this
  // goes down the ordinary charging path.
  const lines = [
    { registrationId: 'paid', amountCents: 29900 },
    { registrationId: 'comped', amountCents: 0 },
  ];
  const perLine = feePerLine(lines, 'card', ORG);
  assertEquals(perLine[1], 0, 'the comped sibling owes nothing');
  assertEquals(perLine[0], 897, 'the paying child still owes its own 3%');
  assertEquals(cartFeeCents(lines, 'card', ORG), 897);
});

Deno.test('a cart of only $0 lines owes nothing at all', () => {
  const lines = [
    { registrationId: 'a', amountCents: 0 },
    { registrationId: 'b', amountCents: 0 },
  ];
  assertEquals(cartFeeCents(lines, 'card', ORG), 0);
});

Deno.test('a negative or unusable amount cannot produce a fee either', () => {
  for (const bad of [-1, -29900, NaN, Infinity]) {
    assertEquals(computePlatformFee(bad, 'card', ORG), 0, String(bad));
  }
});

Deno.test('THE FAMILY-FACING copy shows no fee on a $0 class either', async () => {
  // cartFeeTwinParity already compares the browser and server copies at amount
  // 0, but PARITY IS NOT THE RULE: if both copies returned the $1.99 floor they
  // would agree perfectly and a free class would still advertise "$1.99". The
  // family sees this number on the class card, the Review step and the Pay step
  // before Stripe ever sees anything, so the absolute value is pinned here on
  // the browser copy directly rather than inferred from parity plus the server.
  const WEB = new URL('../../../../src/lib/platformFee.js', import.meta.url);
  const { feeOnCents, totalWithFee } = await import(WEB.href);
  const cfg = { ...ORG, fee_pass_through: true };
  assertEquals(feeOnCents(0, cfg, { passThrough: true }), 0);
  assertEquals(totalWithFee(0, cfg, { passThrough: true }), 0);
});

Deno.test('and a free class is ADVERTISED free - the all-in price adds nothing to $0', () => {
  // The all-in pricing work rewrote every surface a price appears on. On a free
  // class the all-in price must still be nothing: a listing reading "$1.99" for
  // a free class is both the fee we promised not to charge and a wrong price in
  // public, which is the thing section 3 exists to prevent.
  assertEquals(advertisedPriceCents(0, { ...ORG, fee_pass_through: true }), 0);
  assertEquals(advertisedPriceLabel(0, { ...ORG, fee_pass_through: true }), '');
});

// ---------------------------------------------------------------------------
// "donations, tips, gift add-ons" - the gift never enters the fee base.
// ---------------------------------------------------------------------------

Deno.test('the gift is not a cart line, so it can never be fee-bearing', () => {
  // The structural guarantee: the fee is computed from registration lines, and
  // a gift is not one. Adding $250 of donation to a cart must not move the fee
  // by a cent.
  const lines = [{ registrationId: 'r1', amountCents: 29900 }];
  const feeWithoutGift = cartFeeCents(lines, 'card', ORG);

  const gift = validateGift(25000, false, FUND);
  assert(gift.ok, 'the gift itself is valid');
  assertEquals(gift.giftCents, 25000);

  // There is deliberately no way to hand the gift to the fee: it is not a line.
  const feeWithGift = cartFeeCents(lines, 'card', ORG);
  assertEquals(feeWithGift, feeWithoutGift);
  assertEquals(feeWithGift, 897); // 3% of the registration ONLY
});

Deno.test('covering the processing cost on a gift is not an enrops service fee', () => {
  // A donor may opt to cover what the gift costs to process. That money is
  // Stripe's cost, computed from the fund's own cover_fee_pct, and enrops keeps
  // none of it. If it were ever derived from the platform fee config it would
  // silently become a service fee on a donation.
  const gift = validateGift(10000, true, FUND);
  assert(gift.ok);
  assertEquals(gift.coveredFeeCents, Math.round(10000 * FUND.cover_fee_pct));
  // And emphatically NOT the platform fee on the same amount.
  assert(
    gift.coveredFeeCents !== computePlatformFee(10000, 'card', ORG),
    'the covered amount must not be the enrops margin',
  );
});

Deno.test('a receipt never presents a gift as a fee', () => {
  // A family who paid $299 + $8.97 fee + a $50 gift must see the $8.97, not
  // $58.97. The receipt derives the fee as a residual, so the gift has to come
  // out first or the whole donation reads as an enrops charge.
  const got = receiptFeeCents({
    amountTotalCents: 29900 + 897 + 5000,
    registrationSubtotalCents: 29900,
    giftTotalCents: 5000,
  });
  assertEquals(got.feeCents, 897);
  assertEquals(got.anomaly, null);
});

Deno.test('a gift-only total shows no fee rather than charging for the donation', () => {
  const got = receiptFeeCents({
    amountTotalCents: 5000,
    registrationSubtotalCents: 0,
    giftTotalCents: 5000,
  });
  assertEquals(got.feeCents, 0);
  assertEquals(got.anomaly, null);
});

// ---------------------------------------------------------------------------
// SOURCE RATCHETS - the structural guarantees, asserted against the source.
// ---------------------------------------------------------------------------

const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

Deno.test('RATCHET: the gift module never reaches for the platform fee', () => {
  // scholarshipFund computing a fee from computePlatformFee would make every
  // donation fee-bearing in one line, and no arithmetic test above would catch
  // it, because the gift would never appear in a cart line to be tested.
  const src = stripComments(read('../scholarshipFund.ts'));
  assert(
    !/computePlatformFee/.test(src),
    'scholarshipFund now uses computePlatformFee - a donation is about to be charged an enrops service fee (money layer section 4, Terms (v))',
  );
  assert(
    !/cartFeeCents|feePerLine/.test(src),
    'scholarshipFund now uses the cart fee - see above',
  );
});

Deno.test('RATCHET: nothing feeds a gift amount into the fee base', () => {
  // Every caller of the cart fee passes registration lines. A call site that
  // named a gift would be the one-line way to break the Terms.
  for (const rel of [
    '../../create-checkout/index.ts',
    '../../process-installments/index.ts',
    '../../stripe-webhook/index.ts',
  ]) {
    const src = stripComments(read(rel));
    for (const m of src.matchAll(/(?:cartFeeCents|allocateCartFeeByLine|feePerLine)\s*\(([\s\S]{0,200})/g)) {
      assert(
        !/gift|donation|tip/i.test(m[1]),
        `${rel} passes something gift-shaped into the fee base: ${m[1].slice(0, 80)}`,
      );
    }
  }
});

Deno.test('RATCHET: tips do not exist yet, so adding them is a deliberate act', () => {
  // The Terms already promise no fee on tips. There is no tip in the product
  // today, so there is no exclusion to write - but whoever adds one must read
  // this and decide, rather than inherit the registration fee by default.
  const money = [
    '../cartFee.ts',
    '../computePlatformFee.ts',
    '../passThroughFee.ts',
    '../receiptFee.ts',
  ];
  for (const rel of money) {
    const src = stripComments(read(rel));
    assert(
      !/\btip_cents\b|\btipCents\b|\bgratuity/i.test(src),
      `${rel} has grown a tip amount. Money layer section 4 and Terms (v): no service fee on tips. Exclude it from the fee base and pin it here.`,
    );
  }
});
