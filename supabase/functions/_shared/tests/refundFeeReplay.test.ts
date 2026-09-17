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
// transaction's real fee for each historical charge. There is no Stripe key on
// this machine. So the fixtures below are LITERAL cents, written down once and
// checked against the fee model by a single canary test — not recomputed on
// every run from the same module they are meant to be testing.
//
// AND THE FIXTURES ONLY ANCHOR ON ROWS THAT ACTUALLY RECONCILE. Checked all
// ten September rows against one percent of the refunded amount: SIX match
// exactly and FOUR do not. Only matching rows are used below.
//
//   Amit Rasin     24000 -> 240   match      Nehemiah Kalu 20500 -> 205  match
//   Murphy Yolland 28500 -> 285   match      Addie Schmitt 10069 -> 101  match
//   Heidi Nelson   11079 -> 111   match      Everett Myers  2500 ->  25  match
//
//   Laura Lillison 28500 -> 371   OFF BY +86, the gap already on record
//   Leila Banks     9968 -> 101   OFF BY +1
//   Wallace Fritsch 6468 ->  66   OFF BY +1
//   Esme Rosenau   30199 -> 299   OFF BY -3
//
// The three small ones are most likely the margin being taken on the CHARGE
// while the row records the REFUND, which differ on a partial refund and on a
// pass-through total (Esme's 30199 is a 29900 class plus a 299 fee, and 299 is
// exactly one percent of 29900). That is a reading of the shape, NOT a
// verified explanation, and none of it can be settled without the charges.
// So this file locks BEHAVIOUR. It does not reconcile history, and a green run
// must not be read as though it had.

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { computeMarginRefund } from '../refundFeeSplit.ts';
import { readChargeFeeFacts } from '../chargeFeeFacts.ts';
import { estimateStripeFee } from '../estimateStripeFee.ts';

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
