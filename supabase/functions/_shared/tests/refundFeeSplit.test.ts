import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { computeMarginRefund } from '../refundFeeSplit.ts';

// The canonical $100 class, with the real numbers from the fee model:
// family pays $103.00, application fee $6.29 (= $3.00 margin + $3.29 Stripe
// recovery), Stripe's actual processing fee $3.29.
const CLASS_100 = {
  applicationFeeCents: 629,
  stripeFeeCents: 329,
  chargeAmountCents: 10300,
};

Deno.test('full refund returns the margin only, never the Stripe half', () => {
  const got = computeMarginRefund({ ...CLASS_100, refundAmountCents: 10300 });
  assertEquals(got, 300);
});

// THE POLICY, LOCKED. Enrops nets $0 on a refund: it gives back the $3.00 it
// did not earn and keeps the $3.29 it already paid Stripe and cannot recover.
// If someone "fixes" this to refund the whole 629, Enrops silently starts
// losing $3.29 on every refund again. That was the old behaviour, changed
// deliberately on 2026-07-25.
Deno.test('POLICY: the unrecoverable Stripe fee is never pushed back', () => {
  const got = computeMarginRefund({ ...CLASS_100, refundAmountCents: 10300 });
  assertEquals(got < CLASS_100.applicationFeeCents, true);
  assertEquals(CLASS_100.applicationFeeCents - got, CLASS_100.stripeFeeCents);
});

Deno.test('half refund returns half the margin', () => {
  const got = computeMarginRefund({ ...CLASS_100, refundAmountCents: 5150 });
  assertEquals(got, 150);
});

// ── v4 section 2: proration by sessions remaining ─────────────────────────

// The direct-charge shape: no uplift, so the whole application fee is margin
// and Stripe's fee came out of the OPERATOR's balance, never ours.
const DIRECT_60 = {
  applicationFeeCents: 199,
  stripeFeeCents: 0,
  chargeAmountCents: 6199,
};

Deno.test('v4: full refund before the program starts returns the whole margin', () => {
  const got = computeMarginRefund({ ...DIRECT_60, refundAmountCents: 6199, remainingFraction: 1 });
  assertEquals(got, 199);
});

Deno.test('v4: full refund after the program ends returns nothing', () => {
  const got = computeMarginRefund({ ...DIRECT_60, refundAmountCents: 6199, remainingFraction: 0 });
  assertEquals(got, 0);
});

Deno.test('v4: full refund at the halfway point returns half the margin', () => {
  const got = computeMarginRefund({ ...DIRECT_60, refundAmountCents: 6199, remainingFraction: 0.5 });
  assertEquals(got, 100); // 199 * 0.5 = 99.5, rounded
});

Deno.test('proration composes with the destination margin split', () => {
  // $100 class: margin 300 of a 629 application fee. 4 of 8 sessions left.
  const got = computeMarginRefund({ ...CLASS_100, refundAmountCents: 10300, remainingFraction: 0.5 });
  assertEquals(got, 150);
  // Never the whole fee, and never the Stripe half, at any fraction.
  assertEquals(got < CLASS_100.applicationFeeCents - CLASS_100.stripeFeeCents + 1, true);
});

Deno.test('a partial refund of a part-delivered program compounds both shares', () => {
  // Half the charge refunded, three quarters of the program left.
  const got = computeMarginRefund({ ...CLASS_100, refundAmountCents: 5150, remainingFraction: 0.75 });
  assertEquals(got, 113); // 300 * 0.5 = 150, * 0.75 = 112.5, rounded
});

// POLICY, LOCKED. An omitted fraction must behave exactly as before proration
// existed. Every caller that cannot resolve a schedule leaves it unset, and
// that has to mean "refund our whole margin", not "refund nothing".
Deno.test('POLICY: an omitted remainingFraction refunds the full margin', () => {
  const withOut = computeMarginRefund({ ...CLASS_100, refundAmountCents: 10300 });
  const withOne = computeMarginRefund({ ...CLASS_100, refundAmountCents: 10300, remainingFraction: 1 });
  assertEquals(withOut, 300);
  assertEquals(withOut, withOne);
});

Deno.test('a nonsense fraction is clamped, never trusted', () => {
  const high = computeMarginRefund({ ...CLASS_100, refundAmountCents: 10300, remainingFraction: 4 });
  const low = computeMarginRefund({ ...CLASS_100, refundAmountCents: 10300, remainingFraction: -2 });
  const nan = computeMarginRefund({ ...CLASS_100, refundAmountCents: 10300, remainingFraction: NaN });
  assertEquals(high, 300); // clamped to 1, never more than the margin
  assertEquals(low, 0);
  assertEquals(nan, 300); // unparseable -> treated as "unknown" -> full margin
});

Deno.test('proration still respects the already-refunded ceiling', () => {
  const got = computeMarginRefund({
    ...CLASS_100,
    refundAmountCents: 10300,
    remainingFraction: 1,
    alreadyRefundedFeeCents: 250,
  });
  assertEquals(got, 50); // only 50 of the 300 margin is left
});

Deno.test('partial refunds across several calls never exceed the margin', () => {
  let refunded = 0;
  for (let i = 0; i < 4; i++) {
    refunded += computeMarginRefund({
      ...CLASS_100,
      refundAmountCents: 2575, // a quarter each time
      alreadyRefundedFeeCents: refunded,
    });
  }
  assertEquals(refunded, 300);
});

Deno.test('a final full refund after partials returns only what is left', () => {
  const got = computeMarginRefund({
    ...CLASS_100,
    refundAmountCents: 10300,
    alreadyRefundedFeeCents: 150,
  });
  assertEquals(got, 150);
});

Deno.test('nothing left to refund once the margin is exhausted', () => {
  const got = computeMarginRefund({
    ...CLASS_100,
    refundAmountCents: 10300,
    alreadyRefundedFeeCents: 300,
  });
  assertEquals(got, 0);
});

// Degenerate cases: every one must return 0, never a negative (which would
// read as CHARGING the provider on a refund) and never an over-refund (which
// Stripe rejects, failing the whole refund call).
Deno.test('no application fee (legacy or unconnected org) refunds nothing', () => {
  assertEquals(computeMarginRefund({
    applicationFeeCents: 0, stripeFeeCents: 329, chargeAmountCents: 10300, refundAmountCents: 10300,
  }), 0);
});

Deno.test('Stripe fee larger than the whole application fee clamps to 0', () => {
  assertEquals(computeMarginRefund({
    applicationFeeCents: 300, stripeFeeCents: 350, chargeAmountCents: 1500, refundAmountCents: 1500,
  }), 0);
});

Deno.test('zero and negative inputs are refused, not propagated', () => {
  assertEquals(computeMarginRefund({ ...CLASS_100, refundAmountCents: 0 }), 0);
  assertEquals(computeMarginRefund({ ...CLASS_100, refundAmountCents: -500 }), 0);
  assertEquals(computeMarginRefund({ ...CLASS_100, chargeAmountCents: 0, refundAmountCents: 100 }), 0);
});

Deno.test('a refund larger than the charge still returns only the margin', () => {
  assertEquals(computeMarginRefund({ ...CLASS_100, refundAmountCents: 99999 }), 300);
});

Deno.test('capped by the fee actually remaining, so Stripe never rejects it', () => {
  // Margin is the whole fee here (no Stripe recovery), and 600 of 629 is gone.
  assertEquals(computeMarginRefund({
    applicationFeeCents: 629, stripeFeeCents: 0, chargeAmountCents: 10300,
    refundAmountCents: 10300, alreadyRefundedFeeCents: 600,
  }), 29);
});

// The $1.99 floor case: on a $15 drop-in the fee is the floor, and card
// processing on $16.99 is roughly $0.79, so the margin is about $1.20.
Deno.test('floor-priced registration splits correctly', () => {
  const got = computeMarginRefund({
    applicationFeeCents: 278, stripeFeeCents: 79, chargeAmountCents: 1699, refundAmountCents: 1699,
  });
  assertEquals(got, 199);
});

// ACH: Stripe's fee is capped at $5.00, so a large invoice leaves a big margin.
Deno.test('ACH ceiling registration splits correctly', () => {
  const got = computeMarginRefund({
    applicationFeeCents: 1299, stripeFeeCents: 500, chargeAmountCents: 500000, refundAmountCents: 500000,
  });
  assertEquals(got, 799);
});

Deno.test('rounding never lets repeated partials overshoot by a cent', () => {
  // 3 x one-third of an odd amount: proportional rounding could total 301.
  const third = Math.floor(10300 / 3);
  let refunded = 0;
  for (let i = 0; i < 3; i++) {
    refunded += computeMarginRefund({
      ...CLASS_100, refundAmountCents: third, alreadyRefundedFeeCents: refunded,
    });
  }
  assertEquals(refunded <= 300, true);
});
