// receiptFee — the receipt has to add up, and it must never invent a fee.

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { receiptFeeCents } from '../receiptFee.ts';

Deno.test('the ordinary pass-through receipt: the residual IS the fee', () => {
  // A $240 registration at 1%: the family is charged $242.40.
  const got = receiptFeeCents({ amountTotalCents: 24240, registrationSubtotalCents: 24000 });
  assertEquals(got.feeCents, 240);
  assertEquals(got.anomaly, null);
});

Deno.test('a cart of three: the fee is per line and the receipt still adds up', () => {
  // The VIP bundle from staging: three $240 registrations, $7.20 of fee.
  const got = receiptFeeCents({ amountTotalCents: 72720, registrationSubtotalCents: 72000 });
  assertEquals(got.feeCents, 720);
  assertEquals(got.anomaly, null);
});

Deno.test('an absorb org pays exactly its line items: no fee, no anomaly, no row', () => {
  // This is J2S on production today, so it is the case that must not move.
  const got = receiptFeeCents({ amountTotalCents: 24000, registrationSubtotalCents: 24000 });
  assertEquals(got.feeCents, 0);
  assertEquals(got.anomaly, null);
});

Deno.test('a gift is subtracted before the fee, not counted as one', () => {
  // $240 class + $2.40 fee + a $25 gift with $0.75 covered on it.
  const got = receiptFeeCents({
    amountTotalCents: 24240 + 2500 + 75,
    registrationSubtotalCents: 24000,
    giftTotalCents: 2500 + 75,
  });
  assertEquals(got.feeCents, 240);
  assertEquals(got.anomaly, null);
});

Deno.test('FAIL SAFE: a negative residual is never shown as a fee', () => {
  // The total is smaller than its own lines. No fee explains that.
  const got = receiptFeeCents({ amountTotalCents: 20000, registrationSubtotalCents: 24000 });
  assertEquals(got.feeCents, 0);
  assertEquals(typeof got.anomaly, 'string');
});

Deno.test('FAIL SAFE: unusable numbers show no fee rather than NaN', () => {
  // A receipt printing "$NaN" to a parent is the worst outcome here.
  for (const bad of [
    { amountTotalCents: NaN, registrationSubtotalCents: 24000 },
    { amountTotalCents: 24240, registrationSubtotalCents: undefined as unknown as number },
    { amountTotalCents: 24240, registrationSubtotalCents: 24000, giftTotalCents: NaN },
  ]) {
    const got = receiptFeeCents(bad);
    assertEquals(got.feeCents, 0, JSON.stringify(bad));
    assertEquals(typeof got.anomaly, 'string', JSON.stringify(bad));
  }
});

Deno.test('the $1.99 minimum on a tiny line is NOT treated as an error', () => {
  // A $1 registration owes the floor, which exceeds the registration itself.
  // It is flagged as worth a look but the number is still shown, because the
  // receipt has to add up and the family is owed the arithmetic.
  const got = receiptFeeCents({ amountTotalCents: 100 + 199, registrationSubtotalCents: 100 });
  assertEquals(got.feeCents, 199);
  assertEquals(typeof got.anomaly, 'string');
});

Deno.test('THE POINT: line items plus the fee always equal the total shown', () => {
  // The defect this closes, asserted as the invariant rather than a number:
  // whatever the inputs, what the receipt prints must reconcile.
  const cases = [
    { amountTotalCents: 24240, registrationSubtotalCents: 24000, giftTotalCents: 0 },
    { amountTotalCents: 72720, registrationSubtotalCents: 72000, giftTotalCents: 0 },
    { amountTotalCents: 30199, registrationSubtotalCents: 29900, giftTotalCents: 0 },
    { amountTotalCents: 26815, registrationSubtotalCents: 24000, giftTotalCents: 2575 },
    { amountTotalCents: 24000, registrationSubtotalCents: 24000, giftTotalCents: 0 },
  ];
  for (const c of cases) {
    const { feeCents } = receiptFeeCents(c);
    assertEquals(
      c.registrationSubtotalCents + feeCents + (c.giftTotalCents || 0),
      c.amountTotalCents,
      JSON.stringify(c),
    );
  }
});
