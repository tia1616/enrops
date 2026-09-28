// Twin-parity guard for how a family's account credit is spread across a cart,
// built the same way as cartFeeTwinParity.test.ts: src/lib/creditSpread.js is
// plain ESM with no imports, so Deno can execute the browser copy directly and
// compare ANSWERS rather than compare text.
//
// WHY THIS PAIR EXISTS. The family is told what their credit covers twice
// before Stripe sees anything - on the Review step and on the Pay step - and
// both come from the browser copy. What is actually discounted and held comes
// from creditAllocation.ts. A disagreement is not cosmetic: it is a number on
// screen that does not match the card statement, at the last step of a
// checkout.
//
// WHAT IT REPLACES. src/lib/creditQuoteParity.test.mjs claimed to pin this and
// could not: it compared the browser copy against a HAND-WRITTEN mirror of the
// server living in the same file, so check 4 compared that copy against itself.
// Every assertion there stayed green if creditAllocation.ts changed its fill
// order, its id tie-break, or its Stripe-minimum trim. This file executes the
// real thing on both sides, so drift fails here.
//
// If this fails: make the two files agree. Do not loosen the comparison.

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { allocateCreditAcrossLines, STRIPE_MIN_CHARGE_CENTS } from '../creditAllocation.ts';

const WEB = new URL('../../../../src/lib/creditSpread.js', import.meta.url);
const { spreadCreditAcrossLines: webSpread } = await import(WEB.href);

/** The server's answer, expressed the way the browser expresses its own. */
function serverSpread(gross: number[], creditCents: number) {
  const ids = gross.map((_, i) => `r${i}`);
  const alloc = allocateCreditAcrossLines(
    gross.map((amountCents, i) => ({ registrationId: ids[i], amountCents })),
    creditCents,
    ids,
  );
  const byId = new Map(alloc.entries.map((e) => [e.registrationId, e.chargeCents]));
  return {
    lineAmounts: ids.map((id) => byId.get(id)!),
    creditApplied: alloc.totalCreditCents,
  };
}

// Carts the flow actually produces, plus the shapes that break arithmetic.
const CARTS: Array<[string, number[]]> = [
  ['one class', [24000]],
  ['two children', [24000, 18000]],
  ['three children, uneven', [24000, 18000, 9000]],
  ['a VIP bundle - one cart item, three registrations', [24000, 24000, 24000]],
  ['a free line beside a paid one', [0, 12000]],
  ['every line free', [0, 0]],
  ['an empty cart', []],
  ['a one-cent class', [1]],
  ['a cart just over the Stripe floor', [60]],
];

// Balances chosen around every boundary: nothing, a cent, exact cover, over-
// cover, and - the case that had no guard at all - the ones that leave 1 to 49
// cents owing, which Stripe refuses.
const BALANCES = [
  0, 1, 11, 49, 50, 51, 5999, 6000, 8999, 9000, 17999, 18000,
  23950, 23951, 23999, 24000, 24001, 41999, 42000, 51000, 71999, 72000, 99999,
];

Deno.test('the browser and the server spread credit identically', () => {
  for (const [label, gross] of CARTS) {
    for (const credit of BALANCES) {
      const web = webSpread(gross, credit);
      const srv = serverSpread(gross, credit);
      assertEquals(
        web.lineAmounts,
        srv.lineAmounts,
        `per-line amounts differ: ${label}, credit ${credit}`,
      );
      assertEquals(
        web.creditApplied,
        srv.creditApplied,
        `credit applied differs: ${label}, credit ${credit}`,
      );
    }
  }
});

Deno.test('degenerate balances are handled the same way on both sides', () => {
  const gross = [24000, 18000];
  for (const credit of [NaN, Infinity, -Infinity, -1, -24000, 0.4, 2400.7]) {
    const web = webSpread(gross, credit as number);
    const srv = serverSpread(gross, credit as number);
    assertEquals(web.lineAmounts, srv.lineAmounts, `per-line differ at credit ${credit}`);
    assertEquals(web.creditApplied, srv.creditApplied, `applied differs at credit ${credit}`);
  }
});

Deno.test('neither side ever leaves Stripe a charge it would refuse', () => {
  // The defect this pins: credit covering all but a few cents left a 20-cent
  // charge, Stripe threw, the hold was released, and the family's retry was
  // told to wait thirty minutes - forever. Both sides must trim instead.
  for (const [label, gross] of CARTS) {
    const total = gross.reduce((s, a) => s + a, 0);
    // A cart that costs less than the floor ALL BY ITSELF is a pricing
    // problem, not a credit one - a 1-cent class cannot be charged whether or
    // not the family holds credit, and no allocation rule can fix that. This
    // assertion is about the dead zone credit CREATES. (Caught by this test
    // failing on the one-cent cart, which is the right answer to the wrong
    // question.)
    if (total < STRIPE_MIN_CHARGE_CENTS) continue;
    for (const credit of BALANCES) {
      for (const spread of [webSpread(gross, credit), serverSpread(gross, credit)]) {
        const owed = total - spread.creditApplied;
        const inDeadZone = owed > 0 && owed < STRIPE_MIN_CHARGE_CENTS;
        assertEquals(
          inDeadZone,
          false,
          `${label} with credit ${credit} leaves ${owed} owing, which Stripe refuses`,
        );
      }
    }
  }
});

Deno.test('the comparison is load-bearing - a changed rule is detected', () => {
  // Proof the test can fail: filling in a different order gives a different
  // answer on an uneven cart, so the assertions above are not vacuous.
  const gross = [24000, 18000];
  const lines = [
    { registrationId: 'r0', amountCents: 24000 },
    { registrationId: 'r1', amountCents: 18000 },
  ];
  // Read each answer back BY ID, because `entries` comes out in fill order -
  // comparing the arrays positionally would differ for the wrong reason, and
  // comparing two freshly-mapped arrays with !== is always true and proves
  // nothing at all.
  const chargeById = (order: string[]) => {
    const a = allocateCreditAcrossLines(lines, 20000, order);
    return Object.fromEntries(a.entries.map((e) => [e.registrationId, e.chargeCents]));
  };
  const forward = chargeById(['r0', 'r1']);
  const reversed = chargeById(['r1', 'r0']);
  // Forward fills r0 first: it swallows all $200 of credit, leaving $40 owing
  // on r0 and r1 untouched. Reversed fills r1 first: $180 clears it outright
  // and the remaining $20 comes off r0, leaving $220.
  assertEquals(forward, { r0: 4000, r1: 18000 });
  assertEquals(reversed, { r0: 22000, r1: 0 });
  assertEquals(
    JSON.stringify(forward) === JSON.stringify(reversed),
    false,
    'fill order must change the answer, or the parity assertions above are vacuous',
  );
  // And the browser copy agrees with the forward (cart-order) fill, which is
  // the one create-checkout actually asks for.
  assertEquals(webSpread(gross, 20000).lineAmounts, [4000, 18000]);
});
