// cartFee — the money layer's section 4 rule, as tests.
//
// The two numbers below come straight out of the doc and are the reason this
// module exists: "Six children at $228 shows $6.84 six times, not $41.04 once."

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { cartFeeCents, feePerLine, allocateCartFeeByLine } from '../cartFee.ts';
import { computePlatformFee } from '../computePlatformFee.ts';

// The doc's pricing, so these tests say what section 4 says even before any
// org is configured this way. Card 3%, $1.99 floor, $14.99 ceiling.
const NEW_PRICING = {
  platform_fee_card_pct: 0.03,
  platform_fee_ach_pct: 0.02,
  platform_fee_floor_cents: 199,
  platform_fee_cap_cents: 1499,
};

// Every org on prod as of 18 Sept that is still on the old terms: 1%, no
// floor, no real ceiling. Used to prove this change is inert for them.
const OLD_TERMS = {
  platform_fee_card_pct: 0.01,
  platform_fee_ach_pct: 0.01,
  platform_fee_floor_cents: null,
  platform_fee_cap_cents: 2147483647,
};

const line = (id: string, amountCents: number) => ({ registrationId: id, amountCents });

// ── the ceiling ───────────────────────────────────────────────────────────

Deno.test("section 4: six children at $228 pay $6.84 six times, not $14.99 once", () => {
  const cart = [1, 2, 3, 4, 5, 6].map((n) => line(`r${n}`, 22800));

  assertEquals(feePerLine(cart, 'card', NEW_PRICING), [684, 684, 684, 684, 684, 684]);
  assertEquals(cartFeeCents(cart, 'card', NEW_PRICING), 4104); // $41.04

  // THE DEFECT, pinned. The old rule handed the cart total to the same
  // function and collected ONE ceiling on $1,368 of registrations.
  const oldWay = computePlatformFee(22800 * 6, 'card', NEW_PRICING);
  assertEquals(oldWay, 1499);
  assertEquals(4104 - oldWay, 2605); // $26.05 of fee that used to vanish
});

Deno.test('section 4: the ceiling still binds on a single large line', () => {
  // $600 semester: 3% is $18.00, over the $14.99 card ceiling. The ceiling is
  // not being removed, it is being moved onto the line where it belongs.
  assertEquals(feePerLine([line('r1', 60000)], 'card', NEW_PRICING), [1499]);
  // And two of them pay it twice, not once.
  assertEquals(cartFeeCents([line('r1', 60000), line('r2', 60000)], 'card', NEW_PRICING), 2998);
});

// ── the floor, which is the uglier half ───────────────────────────────────

Deno.test('section 4: three small lines pay three floors, not one', () => {
  // $25 drop-ins. 3% is 75c, under the $1.99 floor, so each pays the floor.
  const cart = [line('r1', 2500), line('r2', 2500), line('r3', 2500)];
  assertEquals(feePerLine(cart, 'card', NEW_PRICING), [199, 199, 199]);
  assertEquals(cartFeeCents(cart, 'card', NEW_PRICING), 597);

  // The old rule charged 3% of $75 = $2.25, which is above the floor, so the
  // floor never applied at all and two of the three drop-ins went free.
  assertEquals(computePlatformFee(7500, 'card', NEW_PRICING), 225);
});

Deno.test('section 4: a line is priced the same alone as in a basket', () => {
  // The property that makes the fee explainable to a parent in one sentence.
  const alone = cartFeeCents([line('r1', 2500)], 'card', NEW_PRICING);
  const inABasket = feePerLine(
    [line('r1', 2500), line('r2', 60000), line('r3', 24000)],
    'card',
    NEW_PRICING,
  )[0];
  assertEquals(alone, inABasket);
  assertEquals(alone, 199);
});

// ── inert for every org still on the old terms ────────────────────────────

Deno.test('old terms: no floor and no real ceiling means nothing changes', () => {
  // J2S and The Ukulele Project. With neither clamp binding, the sum of the
  // line fees IS the fee on the total, to within a cent of rounding per line.
  const cart = [line('r1', 24000), line('r2', 28500), line('r3', 29900)];
  const perLine = cartFeeCents(cart, 'card', OLD_TERMS);
  const onTheTotal = computePlatformFee(24000 + 28500 + 29900, 'card', OLD_TERMS);
  assertEquals(perLine, 824);
  assertEquals(onTheTotal, 824);
  assertEquals(perLine, onTheTotal);
});

Deno.test('old terms: the two rules can still differ by rounding, and by at most a cent a line', () => {
  // Stated as a bound rather than asserted equal, because rounding each line
  // separately is not always the same as rounding the sum - and a future
  // reader should see the size of that, not discover it.
  const cart = [line('r1', 1050), line('r2', 1050), line('r3', 1050)];
  const perLine = cartFeeCents(cart, 'card', OLD_TERMS); // 11 + 11 + 11
  const onTheTotal = computePlatformFee(3150, 'card', OLD_TERMS); // round(31.5)
  assertEquals(perLine, 33);
  assertEquals(onTheTotal, 32);
  assertEquals(Math.abs(perLine - onTheTotal) <= cart.length, true);
});

// ── bank is its own rate AND its own ceiling ──────────────────────────────

Deno.test('section 4: bank uses the bank rate on every line', () => {
  const cart = [line('r1', 24000), line('r2', 24000)];
  assertEquals(feePerLine(cart, 'us_bank_account', NEW_PRICING), [480, 480]);
  assertEquals(cartFeeCents(cart, 'us_bank_account', NEW_PRICING), 960);
});

// ── installments ──────────────────────────────────────────────────────────

const row = (id: string, registrationId: string, installmentNumber: number, amountCents: number) =>
  ({ id, registrationId, installmentNumber, amountCents });

Deno.test('installments: each registration splits its OWN fee across its OWN charges', () => {
  // Leila Banks' real schedule from prod, on the old terms: $299 over
  // [9968, 9966, 9966] gives [101, 99, 99]. Reproduced through the new path.
  const rows = [
    row('a1', 'reg', 1, 9968),
    row('a2', 'reg', 2, 9966),
    row('a3', 'reg', 3, 9966),
  ];
  const shares = allocateCartFeeByLine(rows, 'card', OLD_TERMS);
  assertEquals([shares.get('a1'), shares.get('a2'), shares.get('a3')], [101, 99, 99]);
  assertEquals(101 + 99 + 99, computePlatformFee(29900, 'card', OLD_TERMS));
});

Deno.test('installments: two children on plans are two fees, each split on its own', () => {
  const rows = [
    row('a1', 'regA', 1, 8000), row('a2', 'regA', 2, 8000), row('a3', 'regA', 3, 8000),
    row('b1', 'regB', 1, 8000), row('b2', 'regB', 2, 8000), row('b3', 'regB', 3, 8000),
  ];
  const shares = allocateCartFeeByLine(rows, 'card', NEW_PRICING);

  // Each $240 registration owes $7.20, split 240/240/240.
  assertEquals([shares.get('a1'), shares.get('a2'), shares.get('a3')], [240, 240, 240]);
  assertEquals([shares.get('b1'), shares.get('b2'), shares.get('b3')], [240, 240, 240]);

  // And the whole cart owes both fees, which is the same number the
  // pay-in-full path would produce for the same two registrations.
  const total = [...shares.values()].reduce((s, v) => s + v, 0);
  assertEquals(total, 1440);
  assertEquals(total, cartFeeCents([line('regA', 24000), line('regB', 24000)], 'card', NEW_PRICING));
});

Deno.test('installments: charge 1 costs the same whether or not a sibling is in the cart', () => {
  // THE REGRESSION THIS REPLACES. Under the cart rule, two children at $240
  // paid a capped share on charge 1 and an uncapped one on charges 2 and 3.
  // Now a registration's schedule does not depend on what else was bought.
  const alone = allocateCartFeeByLine(
    [row('a1', 'regA', 1, 8000), row('a2', 'regA', 2, 8000), row('a3', 'regA', 3, 8000)],
    'card',
    NEW_PRICING,
  );
  const withSibling = allocateCartFeeByLine(
    [
      row('a1', 'regA', 1, 8000), row('a2', 'regA', 2, 8000), row('a3', 'regA', 3, 8000),
      row('b1', 'regB', 1, 50000), row('b2', 'regB', 2, 50000), row('b3', 'regB', 3, 50000),
    ],
    'card',
    NEW_PRICING,
  );
  assertEquals(alone.get('a1'), withSibling.get('a1'));
  assertEquals(alone.get('a2'), withSibling.get('a2'));
  assertEquals(alone.get('a3'), withSibling.get('a3'));
});

Deno.test('installments: every row gets a number, and the shares sum to the fee exactly', () => {
  const rows = [
    row('a1', 'regA', 1, 10000), row('a2', 'regA', 2, 9999), row('a3', 'regA', 3, 9999),
    row('b1', 'regB', 1, 2500),
  ];
  const shares = allocateCartFeeByLine(rows, 'card', NEW_PRICING);
  for (const r of rows) assertEquals(typeof shares.get(r.id), 'number', r.id);

  const regA = ['a1', 'a2', 'a3'].reduce((s, id) => s + shares.get(id)!, 0);
  assertEquals(regA, computePlatformFee(29998, 'card', NEW_PRICING));
  // regB is a single $25 line on a "plan" of one: it pays the floor, once.
  assertEquals(shares.get('b1'), 199);
});

Deno.test('installments: the caller\'s array is not re-ordered under it', () => {
  // Several callers iterate their own rows again after asking for the shares.
  // Sorting in place would move which charge carries the leftover cent.
  const rows = [
    row('a3', 'regA', 3, 9966),
    row('a1', 'regA', 1, 9968),
    row('a2', 'regA', 2, 9966),
  ];
  const before = rows.map((r) => r.id);
  const shares = allocateCartFeeByLine(rows, 'card', OLD_TERMS);
  assertEquals(rows.map((r) => r.id), before);
  // The remainder still lands on installment 1, whatever order it arrived in.
  assertEquals(shares.get('a1'), 101);
  assertEquals(shares.get('a2'), 99);
  assertEquals(shares.get('a3'), 99);
});

Deno.test('installments: an empty schedule is an empty map, not a throw', () => {
  assertEquals(allocateCartFeeByLine([], 'card', NEW_PRICING).size, 0);
});
