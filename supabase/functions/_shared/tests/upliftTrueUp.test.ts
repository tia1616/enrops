// upliftTrueUp - the provider must not be left paying a processing fee Stripe
// never charged, and Enrops must not hand back margin trying to fix that.

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  findExistingTrueUp,
  runUpliftTrueUp,
  UPLIFT_TRUEUP_KEY,
  upliftOverRecoveryCents,
} from '../upliftTrueUp.ts';
import { computeMarginRefund } from '../refundFeeSplit.ts';

// J2S on production: 1% margin, destination charges, provider bears Stripe.
const margin = (amt: number) => Math.round(amt * 0.01);
const cardEstimate = (amt: number) => Math.round(amt * 0.029) + 30;
const appFee = (amt: number) => margin(amt) + cardEstimate(amt);

Deno.test('the charge that started this: Link funded by bank, 86c back', () => {
  // ch_3UCSDdEEGKl6BPRF0Xn7vSfc, 2026-09-05. $285.00. We quoted 857, Stripe
  // took 771, and the provider was charged the difference for nothing.
  const got = upliftOverRecoveryCents({
    chargeAmountCents: 28500,
    paymentMethodType: 'card',
    actualStripeFeeCents: 771,
    applicationFeeCents: 1142,
  });
  assertEquals(got, 86);
});

Deno.test('every Link-by-bank charge on production reconciles to its real delta', () => {
  // Read off the live platform account 2026-09-21: the 7 charges of the last
  // 100 where Stripe's real fee came in under the estimate. If this total ever
  // moves, the arithmetic moved - not production.
  const live: Array<[number, number, number]> = [
    // [charge amount, Stripe's real fee, the cents owed back]
    [30929, 834, 93],
    [29900, 807, 90],
    [28500, 771, 86],
    [28500, 771, 86],
    [27400, 742, 83],
    [22400, 612, 68],
    [9968, 289, 30],
  ];
  let total = 0;
  for (const [amt, actual, owed] of live) {
    const got = upliftOverRecoveryCents({
      chargeAmountCents: amt,
      paymentMethodType: 'card',
      actualStripeFeeCents: actual,
      applicationFeeCents: appFee(amt),
    });
    assertEquals(got, owed, `charge of ${amt}`);
    total += got;
  }
  assertEquals(total, 536); // $5.36, the whole measured over-recovery.
});

Deno.test('an ordinary card is already correct and must not move a cent', () => {
  // 92 of the 99 destination charges measured. The estimate IS the real fee.
  const amt = 28500;
  const got = upliftOverRecoveryCents({
    chargeAmountCents: amt,
    paymentMethodType: 'card',
    actualStripeFeeCents: cardEstimate(amt),
    applicationFeeCents: appFee(amt),
  });
  assertEquals(got, 0);
});

Deno.test('a bank payment is quoted exactly, so there is nothing to give back', () => {
  // ACH is 0.8% capped at $5 and we quote it precisely; the cap case too.
  for (const amt of [24000, 240000]) {
    const est = Math.min(Math.round(amt * 0.008), 500);
    const got = upliftOverRecoveryCents({
      chargeAmountCents: amt,
      paymentMethodType: 'us_bank_account',
      actualStripeFeeCents: est,
      applicationFeeCents: margin(amt) + est,
    });
    assertEquals(got, 0, `bank charge of ${amt}`);
  }
});

Deno.test('FAIL SAFE: a DIRECT charge never gives back a cent of margin', () => {
  // The dangerous case. On a direct charge Stripe bills the operator, so
  // readChargeFeeFacts reports our fee as 0 and the application fee is clean
  // margin. Subtracting "estimate minus zero" here would refund the entire
  // estimate out of Enrops's margin on every direct charge on the platform.
  const got = upliftOverRecoveryCents({
    chargeAmountCents: 28500,
    paymentMethodType: 'card',
    actualStripeFeeCents: 0,
    applicationFeeCents: 285,
  });
  assertEquals(got, 0);

  // AND ON A BIG MARGIN, where the size check cannot save us. A 3% org taking
  // $1,000 has a $30.00 application fee, comfortably larger than the $29.30
  // card estimate - so the only thing standing between this charge and a $29.30
  // gift out of margin is the destination check itself.
  assertEquals(
    upliftOverRecoveryCents({
      chargeAmountCents: 100000,
      paymentMethodType: 'card',
      actualStripeFeeCents: 0,
      applicationFeeCents: 3000,
    }),
    0,
  );
});

Deno.test('FAIL SAFE: an org that absorbs the processing fee has no uplift to return', () => {
  // J2S on production today: the application fee is margin only. It is smaller
  // than the estimate, which is how we know it cannot contain an uplift.
  const got = upliftOverRecoveryCents({
    chargeAmountCents: 28500,
    paymentMethodType: 'card',
    actualStripeFeeCents: 771,
    applicationFeeCents: 285, // 1% margin, no uplift
  });
  assertEquals(got, 0);
});

Deno.test('FAIL SAFE: under-recovery is absorbed, never clawed back', () => {
  // An international card costs Stripe more than we quoted. Standing policy is
  // to eat it. A negative "refund" would be a charge to the provider.
  const got = upliftOverRecoveryCents({
    chargeAmountCents: 28500,
    paymentMethodType: 'card',
    actualStripeFeeCents: 1200,
    applicationFeeCents: 1142,
  });
  assertEquals(got, 0);
});

Deno.test('FAIL SAFE: unusable numbers do nothing', () => {
  for (const bad of [
    { chargeAmountCents: NaN, actualStripeFeeCents: 771, applicationFeeCents: 1142 },
    { chargeAmountCents: 28500, actualStripeFeeCents: NaN, applicationFeeCents: 1142 },
    { chargeAmountCents: 28500, actualStripeFeeCents: 771, applicationFeeCents: NaN },
    { chargeAmountCents: 28500, actualStripeFeeCents: -771, applicationFeeCents: 1142 },
    { chargeAmountCents: 0, actualStripeFeeCents: 771, applicationFeeCents: 1142 },
  ]) {
    const got = upliftOverRecoveryCents({ ...bad, paymentMethodType: 'card' });
    assertEquals(got, 0, JSON.stringify(bad));
  }
});

Deno.test('a true-up already issued is not issued twice', () => {
  const owed = upliftOverRecoveryCents({
    chargeAmountCents: 28500,
    paymentMethodType: 'card',
    actualStripeFeeCents: 771,
    applicationFeeCents: 1142,
    alreadyRefundedFeeCents: 86,
  });
  // The ceiling still allows it arithmetically - what stops the second call is
  // the tag, which is why the tag is the idempotency mechanism and not this.
  assertEquals(owed, 86);

  const found = findExistingTrueUp(
    [{ id: 'fr_1', amount: 86, metadata: { [UPLIFT_TRUEUP_KEY]: 'pi_abc' } }],
    'pi_abc',
  );
  assertEquals(found?.amount, 86);
  assertEquals(findExistingTrueUp([{ id: 'fr_1', amount: 86, metadata: {} }], 'pi_abc'), null);
  assertEquals(
    findExistingTrueUp(
      [{ id: 'fr_1', amount: 86, metadata: { [UPLIFT_TRUEUP_KEY]: 'pi_OTHER' } }],
      'pi_abc',
    ),
    null,
  );
});

Deno.test('a refund on top of a true-up returns the margin ONCE, not twice', () => {
  // THE COMPOSITION THAT MUST HOLD. refundFeeSplit computes the refundable
  // margin from Stripe's REAL fee, so before this change a full refund already
  // handed the over-recovery back. Doing it at charge time must not mean the
  // provider gets it again at refund time.
  const amt = 28500;
  const fee = appFee(amt); // 1142
  const real = 771;

  const trueUp = upliftOverRecoveryCents({
    chargeAmountCents: amt,
    paymentMethodType: 'card',
    actualStripeFeeCents: real,
    applicationFeeCents: fee,
  });
  assertEquals(trueUp, 86);

  const onRefund = computeMarginRefund({
    applicationFeeCents: fee,
    stripeFeeCents: real,
    chargeAmountCents: amt,
    refundAmountCents: amt,
    alreadyRefundedFeeCents: trueUp,
  });

  // Exactly the 1% margin, and not a cent of the uplift a second time.
  assertEquals(onRefund, margin(amt));
  // And the provider ends up in the same place as before this change existed:
  // the whole recoverable amount, just not waiting on a refund to get it.
  assertEquals(
    trueUp + onRefund,
    computeMarginRefund({
      applicationFeeCents: fee,
      stripeFeeCents: real,
      chargeAmountCents: amt,
      refundAmountCents: amt,
    }),
  );
});

// ---------------------------------------------------------------------------
// runUpliftTrueUp - the part that actually moves money.
// ---------------------------------------------------------------------------

/** The Link-by-bank charge that started this, as Stripe returns it. */
function linkByBankStripe(
  opts: { feeRefunds?: Array<{ id: string; amount: number; metadata: Record<string, string> }> } = {},
) {
  const feeRefunds = opts.feeRefunds ?? [];
  const created: Array<{ feeId: string; params: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const reads: string[] = [];
  return {
    created,
    reads,
    paymentIntents: {
      retrieve(id: string) {
        reads.push(id);
        return Promise.resolve({
          latest_charge: {
            amount: 28500,
            application_fee_amount: 1142,
            application_fee: 'fee_1',
            balance_transaction: { fee: 771 },
            payment_method_details: { type: 'card' },
          },
        });
      },
    },
    applicationFees: {
      retrieve(_id: string) {
        return Promise.resolve({
          amount_refunded: feeRefunds.reduce((s, r) => s + r.amount, 0),
          refunds: { data: feeRefunds },
        });
      },
      createRefund(feeId: string, params: Record<string, unknown>, options: Record<string, unknown>) {
        created.push({ feeId, params, options });
        return Promise.resolve({ amount: params.amount as number });
      },
    },
  };
}

Deno.test('a Link-by-bank charge returns 86c to the provider, tagged', async () => {
  const stripe = linkByBankStripe();
  const got = await runUpliftTrueUp(stripe, {
    paymentIntentId: 'pi_link',
    chargeAccountId: null,
    orgBearsStripeFee: true,
  });
  assertEquals(got.returnedCents, 86);
  assertEquals(stripe.created.length, 1);
  assertEquals(stripe.created[0].params.amount, 86);
  assertEquals(
    (stripe.created[0].params.metadata as Record<string, string>)[UPLIFT_TRUEUP_KEY],
    'pi_link',
  );
  assertEquals(stripe.created[0].options.idempotencyKey, 'uplift_pi_link');
});

Deno.test('THE SECOND DELIVERY refunds nothing', async () => {
  // Two webhook endpoints currently point at the same function, so every event
  // arrives twice. Paying the same 86c twice is the failure this prevents.
  const stripe = linkByBankStripe({
    feeRefunds: [{ id: 'fr_1', amount: 86, metadata: { [UPLIFT_TRUEUP_KEY]: 'pi_link' } }],
  });
  const got = await runUpliftTrueUp(stripe, {
    paymentIntentId: 'pi_link',
    chargeAccountId: null,
    orgBearsStripeFee: true,
  });
  assertEquals(got.returnedCents, 86); // reports what was already returned
  assertEquals(stripe.created.length, 0); // but moves nothing
});

Deno.test('a fee refund from a REFUND blocks the true-up, and is never read as one', () => {
  // This test used to assert the OPPOSITE - that a refund's fee refund should
  // be ignored and the true-up should proceed. Code review showed that pays the
  // over-recovery twice, because refundFeeSplit already included it. The
  // behaviour is now asserted by the two "already returned by a refund" tests
  // below; what remains true here, and still worth pinning, is that the two
  // tags are never confused for one another.
  assertEquals(
    findExistingTrueUp(
      [{ id: 'fr_1', amount: 285, metadata: { enrops_source_refund_id: 're_x' } }],
      'pi_link',
    ),
    null,
  );
});

Deno.test('a direct charge is not even read from Stripe', async () => {
  const stripe = linkByBankStripe();
  const got = await runUpliftTrueUp(stripe, {
    paymentIntentId: 'pi_direct',
    chargeAccountId: 'acct_operator',
    orgBearsStripeFee: true,
  });
  assertEquals(got.returnedCents, 0);
  assertEquals(stripe.reads.length, 0);
  assertEquals(stripe.created.length, 0);
});

Deno.test('an org that absorbs processing is not even read from Stripe', async () => {
  const stripe = linkByBankStripe();
  const got = await runUpliftTrueUp(stripe, {
    paymentIntentId: 'pi_absorb',
    chargeAccountId: null,
    orgBearsStripeFee: false,
  });
  assertEquals(got.returnedCents, 0);
  assertEquals(stripe.reads.length, 0);
  assertEquals(stripe.created.length, 0);
});

Deno.test('NEVER THROWS: a Stripe outage does not fail the registration', async () => {
  // The caller has just taken a family's money. A throw here fails the webhook,
  // Stripe redelivers, and the family gets a second confirmation email over 86c.
  const exploding = {
    paymentIntents: { retrieve: () => Promise.reject(new Error('stripe is down')) },
    applicationFees: {
      retrieve: () => Promise.reject(new Error('stripe is down')),
      createRefund: () => Promise.reject(new Error('stripe is down')),
    },
  };
  const got = await runUpliftTrueUp(exploding, {
    paymentIntentId: 'pi_boom',
    chargeAccountId: null,
    orgBearsStripeFee: true,
  });
  assertEquals(got.returnedCents, 0);
});

Deno.test('NEVER THROWS: the refund call itself failing is swallowed', async () => {
  const stripe = linkByBankStripe();
  stripe.applicationFees.createRefund = () => Promise.reject(new Error('fee refund rejected'));
  const got = await runUpliftTrueUp(stripe, {
    paymentIntentId: 'pi_link',
    chargeAccountId: null,
    orgBearsStripeFee: true,
  });
  assertEquals(got.returnedCents, 0);
  assertEquals(got.reason, 'failed');
});

Deno.test('ACH before it clears: no balance transaction yet, nothing happens', async () => {
  // checkout.session.completed fires days before an ACH debit settles. There is
  // no real fee to compare against, so the true-up must sit this one out and
  // wait for async_payment_succeeded rather than invent a number.
  const stripe = linkByBankStripe();
  stripe.paymentIntents.retrieve = () =>
    Promise.resolve({
      latest_charge: {
        amount: 24000,
        application_fee_amount: 432,
        application_fee: 'fee_1',
        balance_transaction: null,
        payment_method_details: { type: 'us_bank_account' },
      },
    });
  const got = await runUpliftTrueUp(stripe, {
    paymentIntentId: 'pi_ach',
    chargeAccountId: null,
    orgBearsStripeFee: true,
  });
  assertEquals(got.returnedCents, 0);
  assertEquals(stripe.created.length, 0);
});

Deno.test('FAIL SAFE: a rail we do not price is left alone, not guessed at', async () => {
  // The defect this closes, found in self-review. Defaulting an unknown type to
  // 'card' is not conservative: on a 3% org taking $1,000 the application fee
  // ($30.00) is larger than the card estimate ($29.30), so the size guard lets
  // it through, and "card estimate minus a cheap rail's real fee" would have
  // paid out $24-plus of pure margin as an imaginary over-recovery.
  const stripe = linkByBankStripe();
  stripe.paymentIntents.retrieve = () =>
    Promise.resolve({
      latest_charge: {
        amount: 100000,
        application_fee_amount: 3000,
        application_fee: 'fee_1',
        balance_transaction: { fee: 500 },
        payment_method_details: { type: 'some_future_wallet' },
      },
    });
  const got = await runUpliftTrueUp(stripe, {
    paymentIntentId: 'pi_unknown',
    chargeAccountId: null,
    orgBearsStripeFee: true,
  });
  assertEquals(got.returnedCents, 0);
  assertEquals(got.reason, 'unrecognised payment method');
  assertEquals(stripe.created.length, 0);
});

Deno.test('FAIL SAFE: a charge with no payment method details at all', async () => {
  const stripe = linkByBankStripe();
  stripe.paymentIntents.retrieve = () =>
    Promise.resolve({
      latest_charge: {
        amount: 28500,
        application_fee_amount: 1142,
        application_fee: 'fee_1',
        balance_transaction: { fee: 771 },
      },
    });
  const got = await runUpliftTrueUp(stripe, {
    paymentIntentId: 'pi_nodetails',
    chargeAccountId: null,
    orgBearsStripeFee: true,
  });
  assertEquals(got.returnedCents, 0);
  assertEquals(stripe.created.length, 0);
});

Deno.test('FAIL SAFE: a refund got here first, so the excess is NOT returned twice', async () => {
  // Found by code review. refundFeeSplit computes the refundable margin from
  // Stripe's REAL fee, so the 86c over-recovery is already inside any fee
  // refund it issued. Stripe redelivers a failed checkout.session.completed
  // for up to three days - ample time for a family to cancel first - so the
  // charge event genuinely can arrive after the refund.
  const refundedMargin = 371; // 1142 - 771, the whole recoverable amount
  const stripe = linkByBankStripe({
    feeRefunds: [
      { id: 'fr_refund', amount: refundedMargin, metadata: { enrops_source_refund_id: 're_x' } },
    ],
  });
  const got = await runUpliftTrueUp(stripe, {
    paymentIntentId: 'pi_link',
    chargeAccountId: null,
    orgBearsStripeFee: true,
  });
  assertEquals(got.returnedCents, 0);
  assertEquals(got.reason, 'already returned by a refund');
  assertEquals(stripe.created.length, 0);
});

Deno.test('a PARTIAL fee refund also blocks the true-up rather than topping it up', async () => {
  // Same reasoning, and deliberately not clever: a partial refund returned a
  // PROPORTION of a margin that already contained the over-recovery. Working
  // out what is left over is arithmetic nobody can check against Stripe, and
  // the whole amount at stake is cents. Do nothing and leave it to the refund
  // path, which is where the money reconciles.
  const stripe = linkByBankStripe({
    feeRefunds: [{ id: 'fr_partial', amount: 40, metadata: { enrops_source_refund_id: 're_y' } }],
  });
  const got = await runUpliftTrueUp(stripe, {
    paymentIntentId: 'pi_link',
    chargeAccountId: null,
    orgBearsStripeFee: true,
  });
  assertEquals(got.returnedCents, 0);
  assertEquals(stripe.created.length, 0);
});
