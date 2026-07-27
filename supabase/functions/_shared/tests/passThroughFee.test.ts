// Tests for passThroughFee. Pure-function tests; no Supabase or Stripe.
// Run: deno test supabase/functions/_shared/tests/passThroughFee.test.ts

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { passThroughFeeCents, passThroughLineItem, PassThroughConfig } from '../passThroughFee.ts';

// Founding-cohort config: 1% card / 1% ACH / no cap.
const PASS: PassThroughConfig = {
  platform_fee_card_pct: 0.01,
  platform_fee_ach_pct: 0.01,
  platform_fee_cap_cents: 2147483647,
  fee_pass_through: true,
};
const ABSORB: PassThroughConfig = { ...PASS, fee_pass_through: false };

Deno.test('absorb mode adds nothing to what the family pays', () => {
  assertEquals(passThroughFeeCents(27500, 'card', ABSORB), 0);
  assertEquals(passThroughLineItem(27500, 'card', ABSORB), null);
});

Deno.test('fee_pass_through null/undefined is treated as absorb', () => {
  assertEquals(passThroughFeeCents(27500, 'card', { ...PASS, fee_pass_through: null }), 0);
  assertEquals(passThroughFeeCents(27500, 'card', { ...PASS, fee_pass_through: undefined }), 0);
});

Deno.test('pass-through adds 1% of base ($275 -> $2.75)', () => {
  assertEquals(passThroughFeeCents(27500, 'card', PASS), 275);
});

Deno.test('pass-through fee equals the application fee (so operator nets full base)', () => {
  // The fee the family pays must match what the platform keeps — both are
  // computePlatformFee(base). 1% of $275 = 275 cents either way.
  assertEquals(passThroughFeeCents(27500, 'card', PASS), 275);
});

Deno.test('ACH carries the same 1% as card (method-agnostic at these rates)', () => {
  assertEquals(passThroughFeeCents(27500, 'us_bank_account', PASS), 275);
});

// ── Registration fee model: 3% / $1.99 floor / $7.99 cap ───────────────────
const REG: PassThroughConfig = {
  platform_fee_card_pct: 0.03,
  platform_fee_ach_pct: 0.03,
  platform_fee_cap_cents: 799,
  platform_fee_floor_cents: 199,
  fee_pass_through: true,
};

Deno.test('reg model: $4 program parent-facing fee is the $1.99 floor', () => {
  assertEquals(passThroughFeeCents(400, 'card', REG), 199);
  assertEquals(passThroughLineItem(400, 'card', REG)?.price_data.unit_amount, 199);
});

Deno.test('reg model: $100 program parent-facing fee is 3% ($3.00), above floor', () => {
  assertEquals(passThroughFeeCents(10000, 'card', REG), 300);
});

Deno.test('reg model: $300 program parent-facing fee hits the $7.99 cap', () => {
  assertEquals(passThroughFeeCents(30000, 'card', REG), 799);
});

// The LABEL is asserted deliberately, not incidentally. Naming this charge
// "enrops service fee" rather than any kind of "processing fee" is a legal
// requirement, not a copy preference: surcharging a card cost to the customer is
// prohibited in CT/ME/MA and constrained in CA, and "processing" is the word
// that makes a platform fee read as a card surcharge. If someone renames this,
// this test should fail and make them justify it.
Deno.test('pass-through line item is labelled "enrops service fee", never a processing fee', () => {
  const item = passThroughLineItem(27500, 'card', PASS);
  assertEquals(item, {
    price_data: {
      currency: 'usd',
      product_data: {
        name: 'enrops service fee',
        // Reworded 2026-07-27. The old copy denied "card processing surcharge"
        // by name, which planted a term most families have never heard; "not a
        // bank charge" separates it from the card networks in plain words.
        description: "Covers online registration and secure payments. This is enrops's fee, not a bank charge.",
      },
      unit_amount: 275,
    },
    quantity: 1,
  });
  const label = `${item?.price_data.product_data.name} ${item?.price_data.product_data.description}`;
  // No exclusion needed any more: the copy no longer contains the banned words
  // even in a denial, so this can assert the raw string.
  assertEquals(/processing fee|convenience fee|platform fee|surcharge/i.test(label), false);
});

// The two jobs the description has to keep doing, asserted separately from the
// exact wording so a future copy edit can change the sentence without being
// free to drop what makes it lawful: attribute the fee to enrops by name, and
// separate it from the customer's card costs.
Deno.test('fee description still attributes to enrops and separates it from card costs', () => {
  const desc = passThroughLineItem(27500, 'card', PASS)!.price_data.product_data.description;
  assertEquals(/enrops/i.test(desc), true, 'must name enrops as the charging party');
  assertEquals(/not a bank charge|not a card|not a charge from/i.test(desc), true,
    'must distinguish the fee from the customer\'s card/bank costs');
});

Deno.test('fee that rounds to 0 produces no line item (tiny base)', () => {
  // 1% of 24 cents = 0.24 -> rounds to 0 -> no line.
  assertEquals(passThroughFeeCents(24, 'card', PASS), 0);
  assertEquals(passThroughLineItem(24, 'card', PASS), null);
});

Deno.test('no cap: 1% of a large base is not capped', () => {
  // $10,000 -> $100 fee, well under the max-int "no cap" sentinel.
  assertEquals(passThroughFeeCents(1_000_000, 'card', PASS), 10_000);
});
