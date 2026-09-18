// Twin-parity guard for the enrops service fee, built the same way as
// rosterOrderTwinParity.test.ts: src/lib/platformFee.js is plain ESM with no
// imports, so Deno can execute the browser copy directly and compare answers
// rather than compare text.
//
// WHY THIS PAIR EXISTS, AND WHY IT HAD NO GUARD UNTIL NOW. The family sees the
// fee three times before Stripe ever does - on the class card, on the Review
// step and on the Pay step - and all three come from the browser copy. What is
// actually charged comes from the Deno copy. A disagreement is not a cosmetic
// bug: it is a number on screen that does not match the card statement, at the
// last step of a checkout, which is the fastest way there is to lose a family.
//
// IT HAD ALREADY DRIFTED. Found writing this file, 2026-09-18: the browser copy
// read a null/0 cap as "no cap" and the server copy ran Math.min(x, null),
// which coerces to 0 - so an org with no cap configured would have been shown a
// fee and charged nothing. Inert only because every org on prod has a cap set,
// and the new pricing writes exactly that column. The server now reads null as
// no cap, matching the browser and matching how it already treated a null floor.
//
// If this fails: make the two files agree. Do not loosen the comparison.

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { cartFeeCents, allocateCartFeeByLine } from '../cartFee.ts';
import { computePlatformFee } from '../computePlatformFee.ts';

const WEB = new URL('../../../../src/lib/platformFee.js', import.meta.url);
const {
  feeOnCents: webFee,
  cartFeeOnLines: webCartFee,
  cartInstallmentFeeShares: webPlanShares,
} = await import(WEB.href);

// Every fee config on prod as of 2026-09-18, plus the doc's target pricing and
// the two shapes that used to diverge.
const CONFIGS: Array<[string, Record<string, unknown>]> = [
  ['J2S / Ukulele / most orgs: 1%, no floor, no real cap', {
    platform_fee_card_pct: 0.01, platform_fee_ach_pct: 0.01,
    platform_fee_floor_cents: null, platform_fee_cap_cents: 2147483647,
  }],
  ['Branching Minds / Jump Start: 3%, $1.99 floor, stale $7.99 cap', {
    platform_fee_card_pct: 0.03, platform_fee_ach_pct: 0.01,
    platform_fee_floor_cents: 199, platform_fee_cap_cents: 799,
  }],
  ['Enrops own org: 2% / 0.5%, no floor, $5.00 cap', {
    platform_fee_card_pct: 0.02, platform_fee_ach_pct: 0.005,
    platform_fee_floor_cents: null, platform_fee_cap_cents: 500,
  }],
  ["the money layer's target: 3% / 2%, $1.99 floor, $14.99 card / $9.99 bank", {
    platform_fee_card_pct: 0.03, platform_fee_ach_pct: 0.02,
    platform_fee_floor_cents: 199, platform_fee_cap_cents: 1499,
    platform_fee_ach_cap_cents: 999,
  }],
  ['A BANK CEILING WITH NO CARD CEILING, which must not make card free', {
    platform_fee_card_pct: 0.03, platform_fee_ach_pct: 0.02,
    platform_fee_floor_cents: 199, platform_fee_cap_cents: null,
    platform_fee_ach_cap_cents: 999,
  }],
  ['a bank ceiling ABOVE the card one - odd, but it must not leak across', {
    platform_fee_card_pct: 0.03, platform_fee_ach_pct: 0.02,
    platform_fee_floor_cents: null, platform_fee_cap_cents: 500,
    platform_fee_ach_cap_cents: 5000,
  }],
  ['THE SHAPE THAT DIVERGED: no cap at all', {
    platform_fee_card_pct: 0.03, platform_fee_ach_pct: 0.02,
    platform_fee_floor_cents: 199, platform_fee_cap_cents: null,
  }],
  ['a zero cap, which also used to mean two different things', {
    platform_fee_card_pct: 0.03, platform_fee_ach_pct: 0.02,
    platform_fee_floor_cents: null, platform_fee_cap_cents: 0,
  }],
  ['no fee configured at all', {
    platform_fee_card_pct: 0, platform_fee_ach_pct: 0,
    platform_fee_floor_cents: null, platform_fee_cap_cents: null,
  }],
];

// Real prices from prod, the doc's worked examples, and the awkward edges.
const AMOUNTS = [
  0, 1, 99, 100, 2500, 4500, 6468, 8000, 9966, 9968, 10069, 11079,
  20500, 22800, 24000, 28500, 29900, 30199, 32900, 60000, 120000,
];

// The browser helper returns 0 unless the operator passes the fee on, because
// its only job is the family-facing number. The server helper has no such
// gate - passThroughFee.ts applies it. So parity is asserted with the gate on,
// which is the only configuration in which both are answering the same
// question.
const withPassThrough = (cfg: Record<string, unknown>) => ({ ...cfg, fee_pass_through: true });

Deno.test('twin parity: one line, every config, every amount', () => {
  for (const [label, cfg] of CONFIGS) {
    for (const isBank of [false, true]) {
      const method = isBank ? 'us_bank_account' : 'card';
      for (const amount of AMOUNTS) {
        assertEquals(
          // deno-lint-ignore no-explicit-any
          computePlatformFee(amount, method as any, cfg as any),
          webFee(amount, withPassThrough(cfg), { isBank }),
          `${label} | ${method} | ${amount}`,
        );
      }
    }
  }
});

Deno.test('twin parity: a whole cart, every config', () => {
  const CARTS = [
    [24000],
    [24000, 24000],
    [22800, 22800, 22800, 22800, 22800, 22800], // the doc's six children
    [2500, 2500, 2500],                          // three drop-ins, the floor case
    [60000, 2500],                               // one over the ceiling, one under the floor
    [29900, 28500, 24000, 11079],
    [],
    [0],
  ];
  for (const [label, cfg] of CONFIGS) {
    for (const isBank of [false, true]) {
      const method = isBank ? 'us_bank_account' : 'card';
      for (const cart of CARTS) {
        const edge = cartFeeCents(
          cart.map((a, i) => ({ registrationId: `r${i}`, amountCents: a })),
          // deno-lint-ignore no-explicit-any
          method as any,
          // deno-lint-ignore no-explicit-any
          cfg as any,
        );
        assertEquals(
          edge,
          webCartFee(cart, withPassThrough(cfg), { isBank }),
          `${label} | ${method} | [${cart.join(',')}]`,
        );
      }
    }
  }
});

Deno.test('twin parity: payment plans, per registration', () => {
  // Real schedules: one $299 registration over three charges, and two
  // registrations of different sizes sharing a cart.
  const SCHEDULES = [
    [
      { registration_id: 'a', installment_number: 1, amount_cents: 9968 },
      { registration_id: 'a', installment_number: 2, amount_cents: 9966 },
      { registration_id: 'a', installment_number: 3, amount_cents: 9966 },
    ],
    [
      { registration_id: 'a', installment_number: 1, amount_cents: 8000 },
      { registration_id: 'a', installment_number: 2, amount_cents: 8000 },
      { registration_id: 'a', installment_number: 3, amount_cents: 8000 },
      { registration_id: 'b', installment_number: 1, amount_cents: 20000 },
      { registration_id: 'b', installment_number: 2, amount_cents: 20000 },
      { registration_id: 'b', installment_number: 3, amount_cents: 20000 },
    ],
    [
      { registration_id: 'a', installment_number: 1, amount_cents: 834 },
      { registration_id: 'a', installment_number: 2, amount_cents: 833 },
      { registration_id: 'a', installment_number: 3, amount_cents: 833 },
    ],
  ];

  for (const [label, cfg] of CONFIGS) {
    for (const schedule of SCHEDULES) {
      const shares = allocateCartFeeByLine(
        schedule.map((r, i) => ({
          id: String(i),
          registrationId: r.registration_id,
          installmentNumber: r.installment_number,
          amountCents: r.amount_cents,
        })),
        'card',
        // deno-lint-ignore no-explicit-any
        cfg as any,
      );
      // Fold the edge copy up to per-installment totals, which is the shape
      // the browser renders and therefore the only shape worth comparing.
      const numbers = [...new Set(schedule.map((r) => r.installment_number))].sort((a, b) => a - b);
      const edgeByInstallment = numbers.map((n) =>
        schedule.reduce(
          (sum, r, i) => (r.installment_number === n ? sum + (shares.get(String(i)) ?? 0) : sum),
          0,
        )
      );
      assertEquals(
        edgeByInstallment,
        webPlanShares(schedule, withPassThrough(cfg), {}),
        `${label} | schedule of ${schedule.length}`,
      );
    }
  }
});

// A positive control. Every assertion above compares two implementations, so
// they would all pass if BOTH were broken to return 0. This pins one real
// number against the doc's own worked example.
Deno.test('twin parity: and the pair actually computes the doc\'s number', () => {
  const target = {
    platform_fee_card_pct: 0.03, platform_fee_ach_pct: 0.02,
    platform_fee_floor_cents: 199, platform_fee_cap_cents: 1499,
    fee_pass_through: true,
  };
  // "$240 session -> $247.20 listed" : a $7.20 fee.
  assertEquals(webFee(24000, target, { isBank: false }), 720);
  // "Six children at $228 shows $6.84 six times, not $41.04 once."
  assertEquals(webCartFee(new Array(6).fill(22800), target, { isBank: false }), 4104);
});

// The second ceiling, pinned on the BROWSER copy specifically. The server copy
// has its own test; this one exists because the browser is what a family reads,
// and a bank ceiling it did not know about would quote a fee nobody charges.
Deno.test('twin parity: the browser knows about the bank ceiling', () => {
  const target = {
    platform_fee_card_pct: 0.03, platform_fee_ach_pct: 0.02,
    platform_fee_floor_cents: 199, platform_fee_cap_cents: 1499,
    platform_fee_ach_cap_cents: 999,
    fee_pass_through: true,
  };
  // $1,200 camp: card hits $14.99, bank hits $9.99.
  assertEquals(webFee(120000, target, { isBank: false }), 1499);
  assertEquals(webFee(120000, target, { isBank: true }), 999);
  // And with no bank ceiling set - every org today - bank uses the card one.
  const noBankCap = { ...target, platform_fee_ach_cap_cents: null };
  assertEquals(webFee(120000, noBankCap, { isBank: true }), 1499);
});
