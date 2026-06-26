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

Deno.test('pass-through builds a "Platform fee" line item with the fee as unit_amount', () => {
  assertEquals(passThroughLineItem(27500, 'card', PASS), {
    price_data: {
      currency: 'usd',
      product_data: { name: 'Platform fee', description: 'Supports the registration platform (1%).' },
      unit_amount: 275,
    },
    quantity: 1,
  });
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
