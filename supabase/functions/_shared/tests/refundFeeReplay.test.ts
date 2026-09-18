// refundFeeReplay — the money layer's blocker 1, turned into a test that fails
// when any of its four behaviours regresses.
//
// WHY THIS EXISTS, AND WHY IT IS SEPARATE FROM refundFeeSplit.test.ts.
// That file tests the arithmetic of computeMarginRefund in the abstract. This
// one replays the SHAPES that actually occurred on production in September
// 2026, because that is what the money layer (16 Sept 2026, section 6) asks
// for: "run the six September refunds through it and get six correct
// outcomes". The four checkboxes in that section are the four groups below.
//
// WHAT HAPPENED ON PROD, counted 17 Sept 2026 rather than taken from the doc:
// there were SEVENTEEN refunds in September, not six. The six the doc means are
// the 8 September batch, and there were seven of those:
//   2 returned the fee correctly     (Amit Rasin $2.40, Leila Banks $1.01)
//   3 failed on an empty balance     (Lillison $3.71, Marlett $2.40, Schmitt $1.01)
//   2 returned nothing, correctly    (Dillard, Snowley - registered in June,
//                                     before the fee existed, so no margin)
// The doc says two failed. Three did, and 3.71 + 2.40 + 1.01 is exactly the
// $7.12 that was settled by hand on 9 September. Every refund since 10 Sept
// (ten of them) has returned its fee with no shortfall recorded.
//
// WHAT THIS FILE CANNOT DO, stated so nobody reads more into a green run.
// A true replay needs Stripe's real application_fee_amount and the balance
// transaction's real fee for each historical charge. As of 18 September those
// ARE readable - see the reconciliation below - but this file still runs with
// no network, against facts written down from them.
//
// SETTLED 2026-09-18, AND ALL FOUR RECONCILE. The four rows this file used to
// list as unexplained were read off the live charges, read-only, once the
// Stripe key had payments permission. None of them was a refund defect. Every
// one was the same mistake in the CHECK, not in the code: comparing the return
// against refunds.amount_cents. The money layer says so in as many words - do
// not reconcile against the refund amount, reconcile against the original
// charge - and doing that makes all four exact.
//
//   Laura Lillison   appfee 1142, Stripe took 771  -> 371. LINK, 2.6% + 30c.
//                    The 86c gap is the UPLIFT over-charging the provider,
//                    which runs the other way and is section 4's problem.
//   Leila Banks      appfee  420, Stripe took 319  -> 101. Installment 1 of a
//                    29900 registration: 299 allocated over [9968, 9966, 9966]
//                    is [101, 99, 99], remainder on charge 1.
//   Wallace Fritsch  appfee  420, Stripe took 319  -> margin 101, and the
//                    refund was PARTIAL: 101 x 6468/9968 = 65.5 -> 66.
//   Esme Rosenau     direct + pass-through. 30199 paid = 29900 class + 299 fee.
//                    A direct charge carries no uplift, so the whole 299 is
//                    margin and the whole 299 came back.
//
// The fixtures below are still LITERAL cents, written down once and checked
// against the fee model by a single canary test - not recomputed on every run
// from the same module they are meant to be testing.

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { computeMarginRefund } from '../refundFeeSplit.ts';
import { readChargeFeeFacts } from '../chargeFeeFacts.ts';
import { estimateStripeFee } from '../estimateStripeFee.ts';
import { feeReturnOutcome, type FeeReturnOutcome } from '../feeReturnOutcome.ts';
import { allocateFeeAcrossInstallments } from '../feeAllocation.ts';

// ── fixtures: literal cents, from the two live charge models ───────────────
//
// DESTINATION (J2S): 1% margin, stripe_fee_payer='tenant', so the application
// fee is margin + the Stripe estimate, and Stripe's real fee is debited from
// the PLATFORM balance. The recoverable half is application fee MINUS that.
//
// DIRECT (The Ukulele Project, Branching Minds): 1% margin, no uplift, and
// Stripe's fee is debited from the OPERATOR, so it is never subtracted.
//
// These are written down rather than computed. If the fee model changes, the
// canary below fails and a human re-checks the money — which is the point.
// Recomputing them from estimateStripeFee would move the fixture and the
// expectation together and notice nothing.

const J2S_240 = { // Amit Rasin, 8 Sept. Prod returned 240. Anchor row.
  applicationFeeCents: 966, // 240 margin + 726 uplift
  stripeFeeCents: 726,
  chargeAmountCents: 24000,
  expectedMargin: 240,
};

const J2S_285 = { // Murphy Yolland, 7 Sept. Prod returned 285.
  applicationFeeCents: 1142, // 285 margin + 857 uplift
  stripeFeeCents: 857,
  chargeAmountCents: 28500,
  expectedMargin: 285,
};

const DIRECT_11079 = { // Heidi Nelson, 14 Sept. Prod returned 111.
  applicationFeeCents: 111,
  stripeFeeCents: 0,
  chargeAmountCents: 11079,
  expectedMargin: 111,
};

const DIRECT_10069 = { // Addie Schmitt, 8 Sept. Prod returned 101.
  applicationFeeCents: 101,
  stripeFeeCents: 0,
  chargeAmountCents: 10069,
  expectedMargin: 101,
  // Stripe's real fee on this charge, out of the OPERATOR's balance.
  operatorStripeFeeCents: 322,
};

// THE CANARY. The fixtures above are facts about charges that already
// happened. This is the one test that ties them to the live fee model, so a
// change to the margin rate or to Stripe's assumed pricing fails HERE, loudly,
// naming the money, instead of quietly sliding every other expectation along
// with it.
Deno.test('fixtures: the live fee model still produces the September figures', () => {
  for (const f of [J2S_240, J2S_285]) {
    const margin = Math.round(f.chargeAmountCents * 0.01);
    const uplift = estimateStripeFee(f.chargeAmountCents, 'card');
    assertEquals(margin, f.expectedMargin);
    assertEquals(uplift, f.stripeFeeCents);
    assertEquals(margin + uplift, f.applicationFeeCents);
  }
  for (const f of [DIRECT_11079, DIRECT_10069]) {
    assertEquals(Math.round(f.chargeAmountCents * 0.01), f.expectedMargin);
    assertEquals(f.applicationFeeCents, f.expectedMargin); // no uplift
  }
  assertEquals(estimateStripeFee(10069, 'card'), DIRECT_10069.operatorStripeFeeCents);
});

// ── 1. The fee return fires on every refund that has margin to return ──────

Deno.test('blocker1/1: a full refund returns the whole margin, destination', () => {
  assertEquals(
    computeMarginRefund({ ...J2S_240, refundAmountCents: 24000 }),
    J2S_240.expectedMargin,
  );
});

Deno.test('blocker1/1: a full refund returns the whole margin, direct', () => {
  assertEquals(
    computeMarginRefund({ ...DIRECT_11079, refundAmountCents: 11079 }),
    DIRECT_11079.expectedMargin,
  );
});

Deno.test('blocker1/1: the Stripe uplift is never handed back on a destination charge', () => {
  const got = computeMarginRefund({ ...J2S_285, refundAmountCents: 28500 });
  // The whole application fee is margin PLUS uplift. Returning all of it means
  // Enrops pays Stripe's fee out of its own pocket on every refund.
  assertEquals(J2S_285.applicationFeeCents - got, J2S_285.stripeFeeCents);
});

// ── 2. The reversal case, and the read underneath it ───────────────────────
//
// A same-day refund can process as a REVERSAL. The money layer lists this as
// unproven. The evidence says otherwise: Leila Banks' 8 September refund is
// re_3UDPam on prod and it returned its fee. NOT VERIFIED BY ME, and worth
// saying so: that this particular refund processed as a reversal rather than
// an ordinary refund comes from the money layer's own note on ch_3UDPam
// ("Stripe itself labels it Reversed while still charging $3.19"), which no
// one on this machine can re-check without a Stripe key.
//
// The real hazard in a reversal is not the arithmetic, it is the READ. If the
// balance transaction is missing or unexpanded, stripeFeeCents falls back to 0,
// and on a DESTINATION charge that turns the uplift into refundable margin.

interface StubCall {
  id: string;
  params?: unknown;
  options?: unknown;
}

// The stub RECORDS what it was asked for. That matters: the whole reason
// balance_transaction arrives as an object is that readChargeFeeFacts asks for
// it to be expanded. A stub that returns an expanded object no matter what is
// asked cannot notice the expansion being dropped — which is exactly the
// regression that would start the silent over-refund below.
class StubStripe {
  readonly piCalls: StubCall[] = [];
  readonly feeCalls: StubCall[] = [];
  constructor(
    private charge: Record<string, unknown>,
    private fee: Record<string, unknown> | null = null,
  ) {}
  paymentIntents = {
    retrieve: (id: string, params?: unknown, options?: unknown) => {
      this.piCalls.push({ id, params, options });
      return Promise.resolve({ latest_charge: this.charge });
    },
  };
  applicationFees = {
    retrieve: (id: string, params?: unknown) => {
      this.feeCalls.push({ id, params });
      return Promise.resolve(this.fee ?? { amount_refunded: 0, refunds: { data: [] } });
    },
  };
}

function expandedPaths(call: StubCall): string[] {
  return ((call.params as { expand?: string[] } | undefined)?.expand) ?? [];
}

Deno.test('blocker1/2: the balance transaction is actually asked for, and its fee is used', async () => {
  const stripe = new StubStripe({
    amount: J2S_240.chargeAmountCents,
    application_fee_amount: J2S_240.applicationFeeCents,
    application_fee: 'fee_test',
    balance_transaction: { fee: J2S_240.stripeFeeCents },
  });
  const facts = await readChargeFeeFacts(stripe, 'pi_test', null);

  // THE GUARD. Without this the test passes even if production stops asking
  // for the expansion, and prod would then read a bare string id and
  // over-refund every destination charge by the uplift.
  assertEquals(expandedPaths(stripe.piCalls[0]), ['latest_charge.balance_transaction']);
  // Platform-scoped: no Stripe-Account header, even though the charge may live
  // on a connected account. The ApplicationFee belongs to the platform.
  assertEquals(stripe.piCalls[0].options, undefined);

  assertEquals(facts.stripeFeeCents, J2S_240.stripeFeeCents);
  assertEquals(
    computeMarginRefund({ ...facts, refundAmountCents: J2S_240.chargeAmountCents }),
    J2S_240.expectedMargin,
  );
});

// THE ONE THAT MATTERS. Documented as a finding, not asserted as correct
// behaviour: when the balance transaction does not come back as an object,
// stripeFeeCents is 0 and the WHOLE application fee reads as margin. On a
// destination charge that over-refunds by the size of the uplift - $7.26 on a
// $240 class - and it fails silently, because an over-refund looks like a
// successful refund. If this test ever starts failing, somebody has fixed it.
Deno.test('blocker1/2: FINDING - an unexpanded balance transaction over-refunds the uplift', async () => {
  const stripe = new StubStripe({
    amount: J2S_240.chargeAmountCents,
    application_fee_amount: J2S_240.applicationFeeCents,
    application_fee: 'fee_test',
    balance_transaction: 'txn_not_expanded', // a string, not an object
  });
  const facts = await readChargeFeeFacts(stripe, 'pi_test', null);
  assertEquals(facts.stripeFeeCents, 0);
  const got = computeMarginRefund({ ...facts, refundAmountCents: J2S_240.chargeAmountCents });
  assertEquals(got, J2S_240.applicationFeeCents); // the whole fee, uplift included
  assertEquals(got - J2S_240.expectedMargin, J2S_240.stripeFeeCents); // exactly the uplift
});

// THE ASYMMETRY, pinned. On a direct charge the balance transaction DOES come
// back and it carries a real fee - but that fee was debited from the
// OPERATOR's balance, not ours, so subtracting it would under-refund them
// twice over. The stub hands back an expanded transaction with a genuine fee,
// and the assertion is that it is ignored.
//
// An earlier version of this test passed an UNexpanded transaction, which made
// it pass whether or not the asymmetry existed. Caught by mutating
// chargeFeeFacts to drop the `chargeAccountId ? 0 :` guard and watching this
// test stay green. It fails now.
Deno.test('blocker1/2: a direct charge ignores the operator-borne Stripe fee', async () => {
  const stripe = new StubStripe({
    amount: DIRECT_10069.chargeAmountCents,
    application_fee_amount: DIRECT_10069.applicationFeeCents,
    application_fee: 'fee_test',
    balance_transaction: { fee: DIRECT_10069.operatorStripeFeeCents },
  });
  const facts = await readChargeFeeFacts(stripe, 'pi_test', 'acct_direct');
  // The charge read IS account-scoped; only the fee read is platform-scoped.
  assertEquals(stripe.piCalls[0].options, { stripeAccount: 'acct_direct' });
  assertEquals(facts.stripeFeeCents, 0); // the operator's fee, not ours
  assertEquals(
    computeMarginRefund({ ...facts, refundAmountCents: DIRECT_10069.chargeAmountCents }),
    DIRECT_10069.expectedMargin,
  );
});

// ── 3. The empty-balance case, and not paying twice for it ─────────────────
//
// The empty balance itself is a Stripe API error thrown by
// applicationFees.createRefund and handled inside refund-registration, so it is
// not reachable from here. Verified by reading the deployed function on 16
// Sept instead: the family's refund is recorded whatever happens to the fee,
// the shortfall is written to refunds.failure_reason, and an alert is sent.
//
// What IS reachable, and what actually happened on 9 September, is the repair:
// the fee was refunded BY HAND in Stripe. Everything below is about a retry
// after that, because a retry that cannot see the hand-settlement pays twice.

Deno.test('blocker1/3: a hand-settled fee is read back from Stripe and not returned twice', async () => {
  const stripe = new StubStripe(
    {
      amount: J2S_240.chargeAmountCents,
      application_fee_amount: J2S_240.applicationFeeCents,
      application_fee: 'fee_test',
      balance_transaction: { fee: J2S_240.stripeFeeCents },
    },
    // Stripe's record of the 9 September manual repair.
    {
      amount_refunded: J2S_240.expectedMargin,
      refunds: { data: [{ id: 'fr_manual', amount: J2S_240.expectedMargin, metadata: {} }] },
    },
  );
  const facts = await readChargeFeeFacts(stripe, 'pi_test', null);

  // The fee object must actually be fetched, with its refunds expanded, or
  // alreadyRefundedFeeCents silently reads 0 and the retry double-refunds.
  assertEquals(stripe.feeCalls.length, 1);
  assertEquals(expandedPaths(stripe.feeCalls[0]), ['refunds']);
  assertEquals(facts.alreadyRefundedFeeCents, J2S_240.expectedMargin);
  assertEquals(facts.feeRefunds.length, 1);

  assertEquals(
    computeMarginRefund({ ...facts, refundAmountCents: J2S_240.chargeAmountCents }),
    0,
  );
});

Deno.test('blocker1/3: a partially returned fee returns only the remainder', () => {
  const got = computeMarginRefund({
    ...J2S_240,
    refundAmountCents: 24000,
    alreadyRefundedFeeCents: 100,
  });
  assertEquals(got, J2S_240.expectedMargin - 100);
});

// ── 4. Legacy registrations, whose fee carries no Enrops margin ────────────
//
// Lochlan Dillard (registered 4 June) and Adalyn Snowley (5 June) both refunded
// on 8 September and both correctly returned nothing: there was no application
// fee on those charges to give back.

Deno.test('blocker1/4: a pre-fee registration returns nothing, and does not go negative', () => {
  const got = computeMarginRefund({
    applicationFeeCents: 0,
    stripeFeeCents: 0,
    chargeAmountCents: 24000,
    refundAmountCents: 24000,
  });
  assertEquals(got, 0);
  // Paired with a positive control, so this cannot pass merely because the
  // function has been broken into always returning 0.
  assertEquals(computeMarginRefund({ ...J2S_240, refundAmountCents: 24000 }), 240);
});

Deno.test('blocker1/4: a fee entirely consumed by Stripe returns nothing, never a charge', () => {
  // The degenerate destination shape: the uplift is the whole fee.
  const got = computeMarginRefund({
    applicationFeeCents: J2S_240.stripeFeeCents,
    stripeFeeCents: J2S_240.stripeFeeCents,
    chargeAmountCents: 24000,
    refundAmountCents: 24000,
  });
  assertEquals(got, 0);
});

// A zero is returned by BOTH of the cases above and by "we never tried". The
// arithmetic cannot distinguish them and neither can refunds
// .platform_fee_refunded_cents, which is where the money layer's fifth
// checkbox - log every attempt - actually bites. Recorded here so the next
// person does not read a 0 as proof the fee return ran.
Deno.test('blocker1/5: FINDING - zero is ambiguous between nothing-owed and never-tried', () => {
  const nothingOwed = computeMarginRefund({
    applicationFeeCents: 0,
    stripeFeeCents: 0,
    chargeAmountCents: 24000,
    refundAmountCents: 24000,
  });
  const everythingConsumed = computeMarginRefund({
    applicationFeeCents: J2S_240.stripeFeeCents,
    stripeFeeCents: J2S_240.stripeFeeCents,
    chargeAmountCents: 24000,
    refundAmountCents: 24000,
  });
  assertEquals(nothingOwed, everythingConsumed); // both 0, different meanings
});

// ── 6. The definition of done: all seventeen September refunds ─────────────
//
// The money layer (17 Sept 2026) section 6 sets one bar for blocker 1: "run
// the 17 September refunds through it and get 17 correct outcomes." Not six.
// The doc counted seventeen in September and so does production: the query
//
//   select ... from refunds where created_at >= '2026-09-01'
//                            and created_at <  '2026-10-01'
//
// returns exactly seventeen rows, read off the prod ledger on 18 Sept 2026.
// Every one of them is below, with the outcome word it should carry.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. It proves feeReturnOutcome labels
// every shape that actually occurred, which is the checkbox: a word per
// attempt instead of a number to be inferred from. It does NOT reconcile the
// margin arithmetic - four of these rows returned an amount that is not one
// percent of what was refunded, and settling those needs each charge's real
// application fee and balance transaction from Stripe. That is section 6's
// other paragraph, it is a live-mode read-only job, and it is tracked
// separately. A green run here is not a claim about those four amounts.
//
// THE THREE FAILURES ARE RECORDED AS THEY HAPPENED, NOT AS THEY ENDED.
// Lillison, Marlett and Schmitt each show a non-zero platform_fee_refunded_cents
// on prod today (371, 240, 101) because Jessica settled them by hand in Stripe
// on 9 September. At the moment of the attempt, nothing came back and the call
// threw. The attempt is what the column records, so the expected word is
// 'failed' - and that is the whole point: had this column existed on 8
// September, three rows would have said 'failed' on screen instead of hiding
// behind a zero and a hand audit.

interface SeptemberRow {
  who: string;
  day: string;
  /** refunds.amount_cents on prod */
  refundedCents: number;
  /** what the attempt actually returned, at the time */
  returnedCents: number;
  /** what was owed at the time */
  owedCents: number;
  applicationFeeId: string | null;
  failed: boolean;
  expect: FeeReturnOutcome;
}

// Read from prod 2026-09-18. Ordered by created_at, Pacific.
const SEPTEMBER_2026: SeptemberRow[] = [
  // Twelve that returned the fee.
  { who: 'Wallace Fritsch', day: '09-01', refundedCents: 6468, returnedCents: 66, owedCents: 66, applicationFeeId: 'fee_1', failed: false, expect: 'returned' },
  { who: 'Esme Rosenau', day: '09-01', refundedCents: 30199, returnedCents: 299, owedCents: 299, applicationFeeId: 'fee_2', failed: false, expect: 'returned' },
  { who: 'Nehemiah Kalu', day: '09-03', refundedCents: 20500, returnedCents: 205, owedCents: 205, applicationFeeId: 'fee_3', failed: false, expect: 'returned' },
  { who: 'Murphy Yolland', day: '09-07', refundedCents: 28500, returnedCents: 285, owedCents: 285, applicationFeeId: 'fee_4', failed: false, expect: 'returned' },
  { who: 'Amit Rasin', day: '09-08', refundedCents: 24000, returnedCents: 240, owedCents: 240, applicationFeeId: 'fee_5', failed: false, expect: 'returned' },
  // Leila Banks is the reversal case: Stripe labelled this one Reversed and
  // the fee still came back. Section 6's "handles the reversal case" tick.
  { who: 'Leila Banks', day: '09-08', refundedCents: 9968, returnedCents: 101, owedCents: 101, applicationFeeId: 'fee_6', failed: false, expect: 'returned' },
  { who: 'Mia Simpson', day: '09-10', refundedCents: 28500, returnedCents: 285, owedCents: 285, applicationFeeId: 'fee_12', failed: false, expect: 'returned' },
  { who: 'Rosie Wittmayer', day: '09-13', refundedCents: 30199, returnedCents: 299, owedCents: 299, applicationFeeId: 'fee_13', failed: false, expect: 'returned' },
  { who: 'Margot Burke', day: '09-13', refundedCents: 10069, returnedCents: 101, owedCents: 101, applicationFeeId: 'fee_14', failed: false, expect: 'returned' },
  { who: 'Clara Calcagno', day: '09-13', refundedCents: 30199, returnedCents: 299, owedCents: 299, applicationFeeId: 'fee_15', failed: false, expect: 'returned' },
  { who: 'Heidi Nelson', day: '09-14', refundedCents: 11079, returnedCents: 111, owedCents: 111, applicationFeeId: 'fee_16', failed: false, expect: 'returned' },
  { who: 'Everett Myers', day: '09-15', refundedCents: 2500, returnedCents: 25, owedCents: 25, applicationFeeId: 'fee_17', failed: false, expect: 'returned' },

  // Two that correctly returned nothing: registered in June, before the fee
  // existed, so the charge carries no application fee to give back.
  { who: 'Lochlan Dillard', day: '09-08', refundedCents: 24000, returnedCents: 0, owedCents: 0, applicationFeeId: null, failed: false, expect: 'nothing_owed' },
  { who: 'Adalyn Snowley', day: '09-08', refundedCents: 24000, returnedCents: 0, owedCents: 0, applicationFeeId: null, failed: false, expect: 'nothing_owed' },

  // Three that failed on an empty platform balance. 371 + 240 + 101 = 712,
  // exactly the $7.12 settled by hand on 9 September.
  { who: 'Laura Lillison', day: '09-08', refundedCents: 28500, returnedCents: 0, owedCents: 371, applicationFeeId: 'fee_9', failed: true, expect: 'failed' },
  { who: 'Morgan Marlett', day: '09-08', refundedCents: 24000, returnedCents: 0, owedCents: 240, applicationFeeId: 'fee_10', failed: true, expect: 'failed' },
  { who: 'Addie Schmitt', day: '09-08', refundedCents: 10069, returnedCents: 0, owedCents: 101, applicationFeeId: 'fee_11', failed: true, expect: 'failed' },
];

Deno.test('blocker1/DoD: seventeen September refunds, seventeen correct outcomes', () => {
  // The count is asserted first and on its own. If somebody adds a row to the
  // table without adding it to prod, or drops one, this fails before any
  // outcome is checked - because "17 correct outcomes" is a claim about
  // seventeen refunds, not about however many happen to be listed here.
  assertEquals(SEPTEMBER_2026.length, 17, 'prod recorded 17 refunds in September 2026');

  const got: string[] = [];
  for (const row of SEPTEMBER_2026) {
    const outcome = feeReturnOutcome({
      owedCents: row.owedCents,
      applicationFeeId: row.applicationFeeId,
      returnedCents: row.returnedCents,
      failed: row.failed,
    });
    assertEquals(outcome, row.expect, `${row.day} ${row.who}`);
    got.push(outcome);
  }

  // The shape of the month, asserted as a whole. Counting the words is what
  // catches a change that flips several rows the same way at once - which a
  // per-row assertion in a loop would report as one failure and hide the rest.
  assertEquals(got.filter((o) => o === 'returned').length, 12);
  assertEquals(got.filter((o) => o === 'nothing_owed').length, 2);
  assertEquals(got.filter((o) => o === 'failed').length, 3);
});

// The $7.12, pinned to the three rows that produced it. This is the number
// that took a hand audit of production to find, and the reason the column
// exists; if the three 'failed' rows ever stop summing to it, the table above
// has drifted from what happened.
Deno.test('blocker1/DoD: the three failures are exactly the $7.12 settled by hand', () => {
  const failures = SEPTEMBER_2026.filter((r) => r.expect === 'failed');
  assertEquals(failures.length, 3);
  assertEquals(failures.reduce((sum, r) => sum + r.owedCents, 0), 712);
  // Every one of them owed money and returned none. A 'failed' row that
  // returned something would mean the classifier, not the balance, was wrong.
  for (const f of failures) {
    assertEquals(f.returnedCents, 0, f.who);
  }
});

// ── 7. The four that did not reconcile, reconciled ────────────────────────
//
// Every number below was read off the LIVE charge on 18 September 2026, not
// inferred: charge amount, application_fee_amount, and the balance
// transaction's own `fee`. Each one is then put back through the real
// functions. This is the half of section 6 that the seventeen outcomes do not
// cover - the outcomes say WHICH WORD, these say HOW MUCH.

Deno.test('recon: Laura Lillison - the gap is Link pricing, and it runs the other way', () => {
  // ch_3UBlovEEGKl6BPRF0GEyWkRU: amount 28500, application fee 1142, and the
  // balance transaction's fee is 771 - not the 857 the code assumed, because
  // payment_method_details.card.brand is 'link' and Link bills 2.6% + 30c.
  const REAL_STRIPE_FEE = 771;
  const APP_FEE = 1142;

  assertEquals(
    computeMarginRefund({
      applicationFeeCents: APP_FEE,
      stripeFeeCents: REAL_STRIPE_FEE,
      chargeAmountCents: 28500,
      refundAmountCents: 28500,
    }),
    371, // exactly what prod returned
  );

  // AND THE FINDING, asserted so it cannot be forgotten. estimateStripeFee
  // assumes every card is 2.9% + 30c. On a destination charge with
  // stripe_fee_payer='tenant' that estimate is what enrops RECOVERS from the
  // provider, so on a Link payment enrops takes more than Stripe charged -
  // 86c here, out of J2S's payout. The refund was never wrong; the uplift is.
  // Section 4's fee engine inherits this, and it matters more from ship day,
  // when the same estimate sits inside a price a family reads.
  const estimated = estimateStripeFee(28500, 'card');
  assertEquals(estimated, 857);
  assertEquals(estimated - REAL_STRIPE_FEE, 86);
});

Deno.test('recon: Leila Banks - the +1 is the installment remainder, not an error', () => {
  // ch_3UDPamEEGKl6BPRF0kykSSee: installment 1 of 3 on a 29900 registration.
  // Application fee 420, real Stripe fee 319 (plain Visa, so the estimate is
  // exact). Margin = 420 - 319 = 101, and 101 is not 1% of the 9968 charge -
  // it is the registration's 299 allocated across the real schedule.
  const SCHEDULE = [9968, 9966, 9966]; // read from prod's installments rows
  assertEquals(SCHEDULE.reduce((a, b) => a + b, 0), 29900);
  assertEquals(allocateFeeAcrossInstallments(299, SCHEDULE), [101, 99, 99]);

  assertEquals(estimateStripeFee(9968, 'card'), 319); // matches Stripe exactly
  assertEquals(
    computeMarginRefund({
      applicationFeeCents: 420,
      stripeFeeCents: 319,
      chargeAmountCents: 9968,
      refundAmountCents: 9968,
    }),
    101,
  );
});

Deno.test('recon: Wallace Fritsch - a PARTIAL refund returns a proportionate margin', () => {
  // ch_3U5ZKlEEGKl6BPRF0PvUQAr6: same shape as Leila (installment 1 of 29900,
  // app fee 420, Stripe 319, margin 101) but Stripe shows amount_refunded 6468
  // against a 9968 charge and `refunded: false`. 101 x 6468/9968 = 65.53.
  assertEquals(
    computeMarginRefund({
      applicationFeeCents: 420,
      stripeFeeCents: 319,
      chargeAmountCents: 9968,
      refundAmountCents: 6468,
    }),
    66,
  );
  // The control: the SAME charge refunded in full returns the whole margin. If
  // these two ever agree, proration has stopped happening.
  assertEquals(
    computeMarginRefund({
      applicationFeeCents: 420,
      stripeFeeCents: 319,
      chargeAmountCents: 9968,
      refundAmountCents: 9968,
    }),
    101,
  );
});

Deno.test('recon: Esme Rosenau - a direct pass-through charge is margin all the way down', () => {
  // The Ukulele Project is DIRECT with fee_pass_through on: the family paid
  // 30199 = a 29900 class plus a 299 enrops service fee, and Stripe's own cost
  // came out of Jeff's balance, not ours. So there is no uplift inside the
  // application fee and every cent of it is margin.
  assertEquals(
    computeMarginRefund({
      applicationFeeCents: 299,
      stripeFeeCents: 0, // operator-borne on a direct charge
      chargeAmountCents: 30199,
      refundAmountCents: 30199,
    }),
    299,
  );
  // 299 is one percent of the CLASS, not of what the family paid. Pinned,
  // because reading it against 30199 is what made this row look wrong.
  assertEquals(Math.round(29900 * 0.01), 299);
  assertEquals(Math.round(30199 * 0.01), 302);
});

// THE ROUTE, not just the word. Written after watching the seventeen-row test
// stay GREEN through a mutation that deleted feeReturnOutcome's `if
// (facts.failed)` branch entirely.
//
// Why it survived: all three September failures owed money against a real
// ApplicationFee, so they reach 'failed' down the LAST line of the function as
// well as the throw check. Two routes to the same word, and the table could
// not tell which one it was walking. That is the same trap as the balance
// transaction one above - a fixture that agrees with the code for the wrong
// reason.
//
// The shape below is the one that only the throw check catches: an attempt
// that threw before it learned what was owed, so owedCents arrives as 0 with
// no fee id. Asked in the wrong order this reads 'nothing_owed' and a real
// shortfall is filed as "no fee was due". It is not hypothetical - the
// 19 August refund on prod threw inside the Stripe call ("Cannot reverse
// transfer on charge ch_3TWKp8... because it does not have an associated
// transfer") and left platform_fee_refunded_cents NULL, knowing nothing about
// the margin.
Deno.test('blocker1/DoD: an attempt that threw before it learned the amount is still failed', () => {
  assertEquals(
    feeReturnOutcome({ owedCents: 0, applicationFeeId: null, returnedCents: 0, failed: true }),
    'failed',
  );
  // The same facts with no throw are the legitimate zero. If these two ever
  // agree, the column is back to meaning two things.
  assertEquals(
    feeReturnOutcome({ owedCents: 0, applicationFeeId: null, returnedCents: 0, failed: false }),
    'nothing_owed',
  );
});

// THE NEGATIVE CONTROL, and it is the one that earns the suite. Every
// assertion above would still pass if feeReturnOutcome were replaced by a
// lookup that returned row.expect. This asserts the thing the old code could
// NOT do: tell the two zeroes apart. Both rows below returned nothing; only
// one of them is a problem, and the word has to differ.
Deno.test('blocker1/DoD: the two zeroes get different words', () => {
  const neverOwed = SEPTEMBER_2026.find((r) => r.who === 'Lochlan Dillard')!;
  const triedAndFailed = SEPTEMBER_2026.find((r) => r.who === 'Laura Lillison')!;

  const classify = (r: SeptemberRow) =>
    feeReturnOutcome({
      owedCents: r.owedCents,
      applicationFeeId: r.applicationFeeId,
      returnedCents: r.returnedCents,
      failed: r.failed,
    });

  assertEquals(neverOwed.returnedCents, triedAndFailed.returnedCents); // both 0
  assertEquals(classify(neverOwed), 'nothing_owed');
  assertEquals(classify(triedAndFailed), 'failed');
  // Stated as an inequality too, because that is the actual requirement: not
  // which words, but that a zero stops being one word.
  assertEquals(classify(neverOwed) === classify(triedAndFailed), false);
});
