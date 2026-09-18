// feeConfig — the end date on a negotiated rate, and which way it errs.

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { resolveFeeConfig, withResolvedFee } from '../feeConfig.ts';
import { computePlatformFee } from '../computePlatformFee.ts';

// Jeff's actual terms: 1% through 31 December 2030.
const JEFF = {
  platform_fee_card_pct: 0.01,
  platform_fee_ach_pct: 0.01,
  platform_fee_floor_cents: null,
  platform_fee_cap_cents: 2147483647,
  platform_fee_ach_cap_cents: null,
  platform_fee_override_until: '2030-12-31',
};

// The money layer's section 4 numbers, as seeded into platform_settings.
const DEFAULTS = {
  card_pct: 0.03,
  ach_pct: 0.02,
  floor_cents: 199,
  card_cap_cents: 1499,
  ach_cap_cents: 999,
};

const at = (iso: string) => new Date(iso);

// ── no end date: every org on prod today ──────────────────────────────────

Deno.test('no end date means the org keeps its own terms forever', () => {
  const org = { ...JEFF, platform_fee_override_until: null };
  const got = resolveFeeConfig(org, DEFAULTS, at('2099-01-01T00:00:00Z'));
  assertEquals(got.usedPlatformDefaults, false);
  assertEquals(got.platform_fee_card_pct, 0.01);
});

Deno.test('INERT: with no end date set, defaults never apply however long they sit there', () => {
  // Every organisation on prod has override_until NULL, so this is the case
  // that must not move. The defaults row exists in the database from the same
  // migration; this asserts its mere presence changes nothing.
  const org = { ...JEFF, platform_fee_override_until: null };
  for (const when of ['2026-09-18', '2027-06-01', '2031-01-01', '2040-01-01']) {
    const got = resolveFeeConfig(org, DEFAULTS, at(`${when}T12:00:00Z`));
    assertEquals(got.usedPlatformDefaults, false, when);
    assertEquals(got.platform_fee_card_pct, 0.01, when);
  }
});

// ── the boundary, and the direction it errs ───────────────────────────────

Deno.test("the terms still apply ON the last day, everywhere in the world", () => {
  // 31 Dec 2030 in Portland is still 31 Dec while UTC has already rolled over.
  // Naive UTC-date comparison would end Jeff's agreed rate at 4pm his time.
  for (const when of [
    '2030-12-31T00:00:00Z',
    '2030-12-31T23:59:59Z',
    '2031-01-01T07:59:00Z', // 2030-12-31 11:59pm Pacific
  ]) {
    const got = resolveFeeConfig(JEFF, DEFAULTS, at(when));
    assertEquals(got.usedPlatformDefaults, false, when);
    assertEquals(got.platform_fee_card_pct, 0.01, when);
  }
});

Deno.test('the terms have lapsed once the date has passed everywhere', () => {
  const got = resolveFeeConfig(JEFF, DEFAULTS, at('2031-01-02T00:00:00Z'));
  assertEquals(got.usedPlatformDefaults, true);
  assertEquals(got.platform_fee_card_pct, 0.03);
  assertEquals(got.platform_fee_ach_pct, 0.02);
  assertEquals(got.platform_fee_floor_cents, 199);
  assertEquals(got.platform_fee_cap_cents, 1499);
  assertEquals(got.platform_fee_ach_cap_cents, 999);
});

Deno.test('the grace is one day, not open-ended', () => {
  // Stated as a bound so "errs toward the org" cannot quietly become "never
  // expires". A day and a bit after the date, the new pricing is in force.
  assertEquals(resolveFeeConfig(JEFF, DEFAULTS, at('2031-01-01T12:00:00Z')).usedPlatformDefaults, false);
  assertEquals(resolveFeeConfig(JEFF, DEFAULTS, at('2031-01-02T00:00:00Z')).usedPlatformDefaults, true);
});

// ── fail direction ────────────────────────────────────────────────────────

Deno.test('FAIL SAFE: lapsed terms with unreadable defaults keep the ORG\'s numbers', () => {
  const after = at('2031-06-01T00:00:00Z');
  const bad: unknown[] = [
    null, undefined, {},
    { card_pct: 0.03 },                    // no bank rate at all
    { ach_pct: 0.02 },                     // no card rate at all
    { card_pct: 0.03, ach_pct: null },     // Number(null) is 0 - the one that got through
    { card_pct: 0.03, ach_pct: '' },       // Number('') is 0 - same trap
    { card_pct: 0.03, ach_pct: 0 },        // an explicit zero, typed by mistake
    { card_pct: 0, ach_pct: 0.02 },
    { card_pct: 'free', ach_pct: 0.02 },   // not a number
  ];
  for (const d of bad) {
    // deno-lint-ignore no-explicit-any
    const got = resolveFeeConfig(JEFF, d as any, after);
    assertEquals(got.usedPlatformDefaults, false, JSON.stringify(d));
    assertEquals(got.platform_fee_card_pct, 0.01, JSON.stringify(d));
    assertEquals(got.platform_fee_ach_pct, 0.01, JSON.stringify(d));
  }
});

Deno.test('FAIL SAFE: a half-readable defaults row never makes a rail free', () => {
  // The consequence, asserted as money rather than as a flag. Every shape
  // above must leave a real fee on BOTH rails, because "free" is what a
  // missing rate silently becomes.
  const after = at('2031-06-01T00:00:00Z');
  // deno-lint-ignore no-explicit-any
  const got = resolveFeeConfig(JEFF, { card_pct: 0.03, ach_pct: null } as any, after);
  assertEquals(computePlatformFee(24000, 'card', got) > 0, true);
  assertEquals(computePlatformFee(24000, 'us_bank_account', got) > 0, true);
});

Deno.test('an unparseable end date keeps the org\'s terms rather than guessing', () => {
  const org = { ...JEFF, platform_fee_override_until: 'not-a-date' };
  assertEquals(resolveFeeConfig(org, DEFAULTS, at('2099-01-01T00:00:00Z')).usedPlatformDefaults, false);
});

// ── the second ceiling ────────────────────────────────────────────────────

Deno.test('section 4: card pays the $14.99 ceiling, bank pays $9.99', () => {
  const lapsed = resolveFeeConfig(JEFF, DEFAULTS, at('2031-06-01T00:00:00Z'));
  // A $1,200 camp: 3% is $36 on card and 2% is $24 on bank. Both over.
  assertEquals(computePlatformFee(120000, 'card', lapsed), 1499);
  assertEquals(computePlatformFee(120000, 'us_bank_account', lapsed), 999);
});

Deno.test('a null bank ceiling falls back to the card one, which is every org today', () => {
  const org = {
    platform_fee_card_pct: 0.03,
    platform_fee_ach_pct: 0.02,
    platform_fee_floor_cents: 199,
    platform_fee_cap_cents: 799,
    platform_fee_ach_cap_cents: null,
  };
  assertEquals(computePlatformFee(120000, 'card', org), 799);
  assertEquals(computePlatformFee(120000, 'us_bank_account', org), 799);
});

Deno.test('the bank ceiling does not leak onto the card rail', () => {
  const org = {
    platform_fee_card_pct: 0.03,
    platform_fee_ach_pct: 0.02,
    platform_fee_floor_cents: null,
    platform_fee_cap_cents: 1499,
    platform_fee_ach_cap_cents: 999,
  };
  // $600: 3% card = $18 -> capped 1499. 2% bank = $12 -> capped 999.
  assertEquals(computePlatformFee(60000, 'card', org), 1499);
  assertEquals(computePlatformFee(60000, 'us_bank_account', org), 999);
  // And under both ceilings nothing is clamped at all.
  assertEquals(computePlatformFee(10000, 'card', org), 300);
  assertEquals(computePlatformFee(10000, 'us_bank_account', org), 200);
});

Deno.test('bank is still shown as a DISCOUNT: it is never dearer than card', () => {
  // The legal framing in section 4 depends on this being true of the numbers,
  // not just of the wording. Checked across the doc's worked prices.
  const lapsed = resolveFeeConfig(JEFF, DEFAULTS, at('2031-06-01T00:00:00Z'));
  for (const price of [2500, 4500, 8000, 24000, 29900, 60000, 120000]) {
    const card = computePlatformFee(price, 'card', lapsed);
    const bank = computePlatformFee(price, 'us_bank_account', lapsed);
    assertEquals(bank <= card, true, `${price}: bank ${bank} > card ${card}`);
  }
});

// ── asOf, which is how a plan in flight is protected ──────────────────────
//
// process-installments passes the plan's START date rather than today, so an
// expiry cannot land between charge 1 and charge 3. These pin the mechanism it
// relies on. Added after /self-code-review found the behaviour shipped with no
// test at all - and, worse, found the wiring in process-installments had
// silently failed to apply while the commit message claimed it was there.

Deno.test('asOf: a plan that STARTED before the expiry keeps its rate to the end', () => {
  // The family agreed on 1 Dec 2030. Charge 3 falls in April 2031, after the
  // terms lapse. Resolved as of the start, every charge is still 1%.
  const planStart = at('2030-12-01T00:00:00Z');
  const got = withResolvedFee(JEFF, DEFAULTS, planStart);
  assertEquals(got.platform_fee_card_pct, 0.01);
  assertEquals(computePlatformFee(24000, 'card', got), 240);

  // And the same org, asked about a NEW checkout on the same April day, is on
  // the new pricing. Both answers are correct; they are different questions.
  const newCheckout = withResolvedFee(JEFF, DEFAULTS, at('2031-04-01T00:00:00Z'));
  assertEquals(newCheckout.platform_fee_card_pct, 0.03);
  assertEquals(computePlatformFee(24000, 'card', newCheckout), 720);
});

Deno.test('asOf: the family is never billed more mid-plan than they agreed', () => {
  // The consequence, in money. A $240 registration on a three-charge plan
  // started before the expiry: every charge carries the same fee.
  const planStart = at('2030-12-01T00:00:00Z');
  const cfg = withResolvedFee(JEFF, DEFAULTS, planStart);
  const perCharge = computePlatformFee(8000, 'card', cfg);
  assertEquals(perCharge, 80);
  // Under today's-date resolution, charges 2 and 3 would have been 3% instead.
  const ifResolvedToday = withResolvedFee(JEFF, DEFAULTS, at('2031-04-01T00:00:00Z'));
  assertEquals(computePlatformFee(8000, 'card', ifResolvedToday), 240);
  assertEquals(perCharge < 240, true); // the gap this exists to close
});

Deno.test('withResolvedFee leaves every NON-fee field alone', () => {
  // It is handed a whole ConnectOrgConfig by both charge paths, and routing
  // depends on the fields it must not touch.
  const org = {
    ...JEFF,
    stripe_account_id: 'acct_123',
    stripe_charge_model: 'direct',
    stripe_fee_payer: 'tenant',
    fee_pass_through: true,
    name: 'The Ukulele Project',
  };
  const got = withResolvedFee(org, DEFAULTS, at('2031-06-01T00:00:00Z'));
  assertEquals(got.stripe_account_id, 'acct_123');
  assertEquals(got.stripe_charge_model, 'direct');
  assertEquals(got.stripe_fee_payer, 'tenant');
  assertEquals(got.fee_pass_through, true);
  assertEquals(got.name, 'The Ukulele Project');
  // ...while the fee half DID move.
  assertEquals(got.platform_fee_card_pct, 0.03);
});

// ── the doc's worked price table, end to end ──────────────────────────────

Deno.test("section 4's worked prices come out of the resolved defaults", () => {
  const cfg = resolveFeeConfig(JEFF, DEFAULTS, at('2031-06-01T00:00:00Z'));
  const row = (price: number) => [
    price + computePlatformFee(price, 'card', cfg),
    price + computePlatformFee(price, 'us_bank_account', cfg),
  ];
  assertEquals(row(2500), [2699, 2699]);       // $25 drop-in: minimum, no discount
  assertEquals(row(4500), [4699, 4699]);       // $45 single class: minimum
  assertEquals(row(8000), [8240, 8199]);       // $80 short course: save $0.41
  assertEquals(row(24000), [24720, 24480]);    // $240 session: save $2.40
  assertEquals(row(29900), [30797, 30498]);    // $299 semester: save $2.99
  assertEquals(row(60000), [61499, 60999]);    // $600: both maximums, save $5.00
  assertEquals(row(120000), [121499, 120999]); // $1,200 camp: maximums, save $5.00
});
