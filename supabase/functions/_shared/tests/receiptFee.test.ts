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

// THE BANK-DISCOUNT ARRANGEMENT, as arithmetic rather than as layout.
//
// A family paying by bank is charged the BANK fee. Printing "fee $4.80" then
// "discount -$2.40" would make the rows sum to LESS than Total paid - the
// exact defect this work removes, reintroduced by the line meant to be
// generous. So the fee row shows the CARD fee and the discount brings it down
// to what was actually charged.
Deno.test('bank discount: fee row is the CARD fee, and the receipt still reconciles', () => {
  // A $240 registration at an org charging 3% card / 1% bank.
  const regs = 24000;
  const bankFeePaid = 240;   // 1% - what they were actually charged
  const cardFee = 720;       // 3% - what a card would have cost
  const discount = cardFee - bankFeePaid;

  // What the webhook derives from the charge is the BANK fee.
  const derived = receiptFeeCents({
    amountTotalCents: regs + bankFeePaid,
    registrationSubtotalCents: regs,
  });
  assertEquals(derived.feeCents, bankFeePaid);
  assertEquals(derived.anomaly, null);

  // And the printed rows reconcile to the total the family was charged.
  const feeRowShown = derived.feeCents + discount; // the card fee
  assertEquals(feeRowShown, cardFee);
  assertEquals(regs + feeRowShown - discount, regs + bankFeePaid);
});

Deno.test('no discount means the fee row is simply what was paid', () => {
  // Every org whose two rates are equal - J2S and Jeff today.
  const derived = receiptFeeCents({ amountTotalCents: 24240, registrationSubtotalCents: 24000 });
  const discount = 0;
  assertEquals(derived.feeCents + discount, 240);
  assertEquals(24000 + (derived.feeCents + discount) - discount, 24240);
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
