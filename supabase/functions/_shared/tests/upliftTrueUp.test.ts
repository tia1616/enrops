// upliftTrueUp - the provider must not be left paying a processing fee Stripe
// never charged, and Enrops must not hand back margin trying to fix that.

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  findExistingTrueUp,
  runUpliftTrueUp,
  UPLIFT_METADATA_KEY,
  UPLIFT_TRUEUP_KEY,
  upliftOverRecoveryCents,
} from '../upliftTrueUp.ts';
import { UPLIFT_METADATA_KEY as READER_KEY } from '../chargeFeeFacts.ts';
import { computeMarginRefund } from '../refundFeeSplit.ts';

// J2S on production: 1% margin, destination charges, provider bears Stripe.
const margin = (amt: number) => Math.round(amt * 0.01);
const cardUplift = (amt: number) => Math.round(amt * 0.029) + 30;
const appFee = (amt: number) => margin(amt) + cardUplift(amt);

Deno.test('the writers and the reader use the SAME metadata key', () => {
  // A drift here is silent: every true-up would simply find no uplift and do
  // nothing, forever, with no error anywhere.
  assertEquals(UPLIFT_METADATA_KEY, READER_KEY);
  assertEquals(UPLIFT_METADATA_KEY, 'enrops_uplift_cents');
});

Deno.test('the charge that started this: Link funded by bank, 86c back', () => {
  // ch_3UCSDdEEGKl6BPRF0Xn7vSfc, 2026-09-05. $285.00. We recovered 857, Stripe
  // took 771, and the provider was charged the difference for nothing.
  const got = upliftOverRecoveryCents({
    recordedUpliftCents: 857,
    actualStripeFeeCents: 771,
    applicationFeeCents: 1142,
  });
  assertEquals(got, 86);
});

Deno.test('every Link-by-bank charge on production reconciles to its real delta', () => {
  // Read off the live platform account 2026-09-21: the 7 charges of the last
  // 100 where Stripe's real fee came in under what we recovered. None of these
  // carried a pass-through line, so the uplift equals the card rate on the
  // charge - which is why these numbers survive the move to recorded metadata.
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
      recordedUpliftCents: cardUplift(amt),
      actualStripeFeeCents: actual,
      applicationFeeCents: appFee(amt),
    });
    assertEquals(got, owed, `charge of ${amt}`);
    total += got;
  }
  assertEquals(total, 536); // $5.36, the whole measured over-recovery.
});

Deno.test('THE PASS-THROUGH CASE: the reason the uplift is recorded and not rebuilt', () => {
  // Found by code review. A provider who passes the fee on to families has an
  // extra line on the charge, so the charge total is BIGGER than the base the
  // uplift was sized on. Rebuilding the uplift from the charge total therefore
  // overstates it, and the difference comes out of Enrops's margin.
  const regTotal = 29900;        // what the uplift was sized on
  const passThroughLine = 598;   // a 2% service fee the family also pays
  const chargeTotal = regTotal + passThroughLine; // 30498, what Stripe bills
  const recordedUplift = cardUplift(regTotal);    // 897, what we really took
  const actual = Math.round(chargeTotal * 0.026) + 30; // 823, Link by bank

  // The honest answer, from the recorded fact.
  const got = upliftOverRecoveryCents({
    recordedUpliftCents: recordedUplift,
    actualStripeFeeCents: actual,
    applicationFeeCents: margin(regTotal) + recordedUplift,
  });
  assertEquals(got, 74);

  // What the first version computed, by rebuilding the uplift from the charge
  // total. 17c of pure margin, on one $299 registration.
  const rebuiltFromChargeTotal = cardUplift(chargeTotal) - actual;
  assertEquals(rebuiltFromChargeTotal, 91);
  assertEquals(rebuiltFromChargeTotal - got, 17);
});

Deno.test('an ordinary card is already correct and must not move a cent', () => {
  // 92 of the 99 destination charges measured. What we recovered IS the fee.
  const got = upliftOverRecoveryCents({
    recordedUpliftCents: 857,
    actualStripeFeeCents: 857,
    applicationFeeCents: 1142,
  });
  assertEquals(got, 0);
});

Deno.test('a bank payment is quoted exactly, so there is nothing to give back', () => {
  for (const amt of [24000, 240000]) {
    const uplift = Math.min(Math.round(amt * 0.008), 500);
    const got = upliftOverRecoveryCents({
      recordedUpliftCents: uplift,
      actualStripeFeeCents: uplift,
      applicationFeeCents: margin(amt) + uplift,
    });
    assertEquals(got, 0, `bank charge of ${amt}`);
  }
});

Deno.test('FAIL SAFE: a charge with no recorded uplift is left alone', () => {
  // Every charge created before this shipped. Guessing what the uplift was is
  // exactly the defect the recorded metadata removes, so null means stop.
  assertEquals(
    upliftOverRecoveryCents({
      recordedUpliftCents: null,
      actualStripeFeeCents: 771,
      applicationFeeCents: 1142,
    }),
    0,
  );
});

Deno.test('FAIL SAFE: a DIRECT charge never gives back a cent of margin', () => {
  // On a direct charge Stripe bills the operator, so readChargeFeeFacts reports
  // our fee as 0 and the application fee is clean margin. Without the
  // destination check, "uplift minus zero" would gift the whole uplift away.
  assertEquals(
    upliftOverRecoveryCents({
      recordedUpliftCents: 857,
      actualStripeFeeCents: 0,
      applicationFeeCents: 285,
    }),
    0,
  );
  // And on a big margin, where the size check cannot save us: a 3% org taking
  // $1,000 has a $30.00 fee, larger than a $29.30 uplift.
  assertEquals(
    upliftOverRecoveryCents({
      recordedUpliftCents: 2930,
      actualStripeFeeCents: 0,
      applicationFeeCents: 3000,
    }),
    0,
  );
});

Deno.test('FAIL SAFE: an org that absorbs the processing fee records a zero uplift', () => {
  assertEquals(
    upliftOverRecoveryCents({
      recordedUpliftCents: 0,
      actualStripeFeeCents: 771,
      applicationFeeCents: 285,
    }),
    0,
  );
});

Deno.test('FAIL SAFE: a fee too small to contain its own recorded uplift', () => {
  // The two numbers disagree about the same charge. Something is wrong, and
  // the safe reading of "wrong" is to touch nothing.
  assertEquals(
    upliftOverRecoveryCents({
      recordedUpliftCents: 857,
      actualStripeFeeCents: 771,
      applicationFeeCents: 400,
    }),
    0,
  );
});

Deno.test('FAIL SAFE: under-recovery is absorbed, never clawed back', () => {
  // An international card costs Stripe more than we recovered. Standing policy
  // is to eat it. A negative "refund" would be a charge to the provider.
  assertEquals(
    upliftOverRecoveryCents({
      recordedUpliftCents: 857,
      actualStripeFeeCents: 1200,
      applicationFeeCents: 1142,
    }),
    0,
  );
});

Deno.test('FAIL SAFE: unusable numbers do nothing', () => {
  for (const bad of [
    { recordedUpliftCents: NaN, actualStripeFeeCents: 771, applicationFeeCents: 1142 },
    { recordedUpliftCents: 857, actualStripeFeeCents: NaN, applicationFeeCents: 1142 },
    { recordedUpliftCents: 857, actualStripeFeeCents: 771, applicationFeeCents: NaN },
    { recordedUpliftCents: 857, actualStripeFeeCents: -771, applicationFeeCents: 1142 },
    { recordedUpliftCents: -1, actualStripeFeeCents: 771, applicationFeeCents: 1142 },
  ]) {
    assertEquals(upliftOverRecoveryCents(bad), 0, JSON.stringify(bad));
  }
});

Deno.test('the tag, not the arithmetic, is what stops a second true-up', () => {
  const owed = upliftOverRecoveryCents({
    recordedUpliftCents: 857,
    actualStripeFeeCents: 771,
    applicationFeeCents: 1142,
    alreadyRefundedFeeCents: 86,
  });
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

Deno.test("a refund's fee refund is never read as a true-up", () => {
  assertEquals(
    findExistingTrueUp(
      [{ id: 'fr_1', amount: 285, metadata: { enrops_source_refund_id: 're_x' } }],
      'pi_link',
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
    recordedUpliftCents: cardUplift(amt),
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
  opts: {
    feeRefunds?: Array<{ id: string; amount: number; metadata: Record<string, string> }>;
    metadata?: Record<string, unknown> | null;
  } = {},
) {
  const feeRefunds = opts.feeRefunds ?? [];
  const metadata = opts.metadata === undefined ? { [UPLIFT_METADATA_KEY]: '857' } : opts.metadata;
  const created: Array<{ feeId: string; params: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const reads: string[] = [];
  return {
    created,
    reads,
    paymentIntents: {
      retrieve(id: string) {
        reads.push(id);
        return Promise.resolve({
          metadata,
          latest_charge: {
            amount: 28500,
            application_fee_amount: 1142,
            application_fee: 'fee_1',
            balance_transaction: { fee: 771 },
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

const DESTINATION = { chargeAccountId: null, orgBearsStripeFee: true } as const;

Deno.test('a Link-by-bank charge returns 86c to the provider, tagged', async () => {
  const stripe = linkByBankStripe();
  const got = await runUpliftTrueUp(stripe, { paymentIntentId: 'pi_link', ...DESTINATION });
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
  const got = await runUpliftTrueUp(stripe, { paymentIntentId: 'pi_link', ...DESTINATION });
  assertEquals(got.returnedCents, 86); // reports what was already returned
  assertEquals(stripe.created.length, 0); // but moves nothing
});

Deno.test('FAIL SAFE: a refund got here first, so the excess is NOT returned twice', async () => {
  // refundFeeSplit computes the refundable margin from Stripe's REAL fee, so
  // the 86c is already inside any fee refund it issued. Stripe redelivers a
  // failed checkout.session.completed for up to three days - ample time for a
  // family to cancel first - so the charge event genuinely can arrive later.
  const stripe = linkByBankStripe({
    feeRefunds: [{ id: 'fr_refund', amount: 371, metadata: { enrops_source_refund_id: 're_x' } }],
  });
  const got = await runUpliftTrueUp(stripe, { paymentIntentId: 'pi_link', ...DESTINATION });
  assertEquals(got.returnedCents, 0);
  assertEquals(got.reason, 'already returned by a refund');
  assertEquals(stripe.created.length, 0);
});

Deno.test('a PARTIAL fee refund also blocks the true-up rather than topping it up', async () => {
  // Deliberately not clever: a partial refund returned a PROPORTION of a margin
  // that already contained the over-recovery. Working out what is left is
  // arithmetic nobody can check against Stripe, for cents.
  const stripe = linkByBankStripe({
    feeRefunds: [{ id: 'fr_partial', amount: 40, metadata: { enrops_source_refund_id: 're_y' } }],
  });
  const got = await runUpliftTrueUp(stripe, { paymentIntentId: 'pi_link', ...DESTINATION });
  assertEquals(got.returnedCents, 0);
  assertEquals(stripe.created.length, 0);
});

Deno.test('FAIL SAFE: a charge with no uplift metadata does nothing', async () => {
  for (const metadata of [null, {}, { [UPLIFT_METADATA_KEY]: '' }, { [UPLIFT_METADATA_KEY]: 'x' }]) {
    const stripe = linkByBankStripe({ metadata });
    const got = await runUpliftTrueUp(stripe, { paymentIntentId: 'pi_old', ...DESTINATION });
    assertEquals(got.returnedCents, 0, JSON.stringify(metadata));
    assertEquals(got.reason, 'no recorded uplift', JSON.stringify(metadata));
    assertEquals(stripe.created.length, 0);
  }
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
  const got = await runUpliftTrueUp(exploding, { paymentIntentId: 'pi_boom', ...DESTINATION });
  assertEquals(got.returnedCents, 0);
});

Deno.test('NEVER THROWS: the refund call itself failing is swallowed', async () => {
  const stripe = linkByBankStripe();
  stripe.applicationFees.createRefund = () => Promise.reject(new Error('fee refund rejected'));
  const got = await runUpliftTrueUp(stripe, { paymentIntentId: 'pi_link', ...DESTINATION });
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
      metadata: { [UPLIFT_METADATA_KEY]: '192' },
      latest_charge: {
        amount: 24000,
        application_fee_amount: 432,
        application_fee: 'fee_1',
        balance_transaction: null,
      },
    });
  const got = await runUpliftTrueUp(stripe, { paymentIntentId: 'pi_ach', ...DESTINATION });
  assertEquals(got.returnedCents, 0);
  assertEquals(stripe.created.length, 0);
});
