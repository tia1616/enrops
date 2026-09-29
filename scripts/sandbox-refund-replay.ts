#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env --allow-write
//
// sandbox-refund-replay — the money layer's definition of done for blocker 1.
//
//   "Definition of done: run the 17 September refunds through it in a sandbox
//    and get 17 correct outcomes."
//        - MONEY LAYER, 17 September 2026, section 6
//
// WHAT THIS DOES THAT THE OFFLINE TEST CANNOT.
// supabase/functions/_shared/tests/refundFeeReplay.test.ts already replays these
// seventeen rows, but from facts written down by hand and with no network. It
// says so itself: "A true replay needs Stripe's real application_fee_amount and
// the balance transaction's real fee for each historical charge." This script is
// that replay. For every row it builds a REAL Stripe test-mode charge of the
// right shape, then runs the SAME three production modules the refund path runs
// - readChargeFeeFacts, computeMarginRefund, feeReturnOutcome - over Stripe's
// own objects, issues the family's refund and attempts the fee return for real,
// and checks the word that comes out.
//
// So the numbers under test stop being mine. application_fee_amount is read back
// off the charge Stripe created; the Stripe fee is read off the real balance
// transaction; the fee return is a real applicationFees.createRefund; and the
// three failures throw a real Stripe error.
//
// TEST MODE ONLY, AND THE GUARD IS THE FIRST THING THAT RUNS. The key must begin
// sk_test_ or this refuses to start, and the first object it creates is checked
// for livemode: false before anything else happens. It touches no enrops
// database, reads no family data, and moves no real money.
//
// HOW TO RUN IT:
//
//   deno run --allow-net --allow-read --allow-env --allow-write \
//     scripts/sandbox-refund-replay.ts --json=docs/handoffs/refund-replay.json
//
// The key comes from STRIPE_TEST_SECRET_KEY in the environment, or from
// .env.local at the repo root — which is the main clone, so a run from a
// worktree passes the variable instead. Add --dry-run to print the plan without
// touching Stripe (no key needed), --json=<path> to write the result, and
// --destination-account / --direct-account to pin the connected accounts
// instead of discovering them.
//
// --allow-write is only needed for --json, and the permission is checked BEFORE
// the first charge: a missing flag must not surface after seventeen charges
// have been created and the verdict is already computed.
//
// WHAT IT PROVES, AND THE TWO THINGS IT DOES NOT.
//  1. A sandbox cannot drain the platform balance. Test mode lets the platform
//     go negative, so the 8 September "balance too low" error is not
//     reproducible. The three failing rows instead exhaust the application fee
//     between the family refund and the fee return, which makes Stripe throw on
//     a correctly sized call - the same CONSEQUENCE (family refunded, fee return
//     threw, the row must say 'failed') from a different cause. Stated here
//     rather than buried, because "we reproduced the failure" would be a
//     stronger claim than the truth.
//  2. Laura Lillison's charge was funded by Link, which Stripe bills at
//     2.6% + 30c rather than 2.9% + 30c. Test mode has no Link-funded card, so
//     her sandbox charge is billed at the card rate and the margin reads 285
//     where production owed 371. Her row carries that caveat in the table and
//     the runner honours it. Her outcome word is unaffected.
//
// Every other row is expected to match production to the cent, and a cents
// mismatch on a row with no caveat FAILS the run. "Seventeen correct outcomes"
// is the bar, but a right word over a wrong amount is not a result worth having.
//
// AND THAT IS NOT A PEDANTIC ADDITION - the doc's bar, taken literally, is not
// enough. Proved by mutation on 2026-09-29: dropping the balance_transaction
// expansion from chargeFeeFacts (the silent over-refund the offline test
// documents as a FINDING) still produces SEVENTEEN CORRECT OUTCOMES. It flags
// seven rows on cents, six of which really moved the money: 207 + 620 + 857 +
// 726 + 319 + 857 = $35.86 handed back over and above the margin, out of
// enrops's own pocket. Only the cents check catches it.
// Dropping the direct-charge asymmetry instead fails both ways: 10 of 17 words
// and every Ukulele row silently returning nothing.
//
// WHAT THIS REPLAY CANNOT CATCH, measured rather than assumed. Deleting
// feeReturnOutcome's `if (facts.failed)` branch passes here 17 of 17, because
// all three failures also owed money against a real fee and reach 'failed' down
// the function's last line. The offline test covers exactly that shape (an
// attempt that threw before it learned the amount) and goes red on it. The two
// files are complements, not substitutes: this one proves the numbers Stripe
// really returns, that one proves the branches Stripe cannot be made to take.
//
// THE LIMITATION TO KNOW BEFORE TRUSTING A FUTURE RUN. The three modules below
// are production's own, imported, not copied - but the GLUE around them (the
// order of the calls, the try/catch that sets `failed`, the arguments passed)
// is written out again here, because in refund-registration it is interleaved
// with Supabase writes and cannot be imported. It matches index.ts as of
// 2026-09-29: facts, then computeMarginRefund, then refunds.create, then
// applicationFees.createRefund, then feeReturnOutcome. Nothing enforces that it
// stays matched. If the refund path's ORDER changes, re-read this against it
// before believing a green run. Two known and deliberate differences:
// remainingFraction is pinned to 1 here (it was 1 for all seventeen), and
// production gates reverse_transfer on the charge really having a transfer,
// which every destination charge built here does.

import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { readChargeFeeFacts } from '../supabase/functions/_shared/chargeFeeFacts.ts';
import { computeMarginRefund } from '../supabase/functions/_shared/refundFeeSplit.ts';
import { feeReturnOutcome, type FeeReturnOutcome } from '../supabase/functions/_shared/feeReturnOutcome.ts';
import {
  SEPTEMBER_2026,
  SEPTEMBER_2026_SHAPE,
  type SeptemberRow,
} from '../supabase/functions/_shared/tests/data/september2026Refunds.ts';

// ── arguments ──────────────────────────────────────────────────────────────

function flag(name: string): string | null {
  const hit = Deno.args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const eq = hit.indexOf('=');
  return eq === -1 ? '' : hit.slice(eq + 1);
}

const DRY_RUN = flag('dry-run') !== null;
const JSON_OUT = flag('json');
const PINNED_DESTINATION = flag('destination-account');
const PINNED_DIRECT = flag('direct-account');

// ── the plan, printable without a key ──────────────────────────────────────
// Above the key resolution on purpose: --dry-run must work on a machine that
// has no Stripe key at all, or it is not much of a dry run.

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function padStart(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

if (DRY_RUN) {
  console.log(`DRY RUN — nothing will be created. ${SEPTEMBER_2026.length} rows:\n`);
  for (const r of SEPTEMBER_2026) {
    console.log(
      `  ${r.day}  ${pad(r.who, 17)} ${pad(r.model, 12)} charge ${padStart(String(r.chargeAmountCents), 6)}` +
        `  fee ${padStart(String(r.applicationFeeCents), 5)} (${r.appFeeSource})` +
        `  refund ${padStart(String(r.refundedCents), 6)}  expect ${r.expect}` +
        (r.sandboxCaveat ? '  [caveated]' : ''),
    );
  }
  Deno.exit(0);
}

// ── the key, and the guard that makes this safe ────────────────────────────

/**
 * Resolve the test key. Never printed, never logged, never written to the
 * artifact.
 *
 * Reads the environment first so a caller can override, and falls back to
 * .env.local, which is where the key Arielle approved on 17 September lives.
 */
async function resolveTestKey(): Promise<string> {
  const fromEnv = Deno.env.get('STRIPE_TEST_SECRET_KEY');
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const path = new URL('../.env.local', import.meta.url);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    throw new Error(
      'No STRIPE_TEST_SECRET_KEY in the environment and no .env.local to read it from.',
    );
  }
  const line = text.split('\n').find((l) => l.trimStart().startsWith('STRIPE_TEST_SECRET_KEY='));
  if (!line) throw new Error('.env.local has no STRIPE_TEST_SECRET_KEY line.');
  const value = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error('STRIPE_TEST_SECRET_KEY is empty.');
  return value;
}

const key = await resolveTestKey();
// THE GUARD. This script issues refunds. A live key here would issue them
// against real families, so the prefix is checked before a client is even
// constructed, and the failure is fatal rather than a warning.
if (!key.startsWith('sk_test_')) {
  console.error(
    'REFUSING TO RUN: the key does not begin sk_test_.\n' +
      'This script creates charges and issues refunds. It runs in Stripe test mode only.',
  );
  Deno.exit(2);
}

const stripe = new Stripe(key, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

// ── the sandbox's own knobs ────────────────────────────────────────────────

/**
 * Stripe's test PaymentMethod for 4000 0000 0000 0077: "funds are added
 * directly to your available balance, bypassing your pending balance".
 *
 * NOT cosmetic. An ordinary test card leaves the money pending, and a
 * destination refund with reverse_transfer then fails with "the recipient of
 * this transfer does not have sufficient funds" - which looks exactly like a
 * refund-path defect and is not one. Found the hard way.
 */
const TEST_PAYMENT_METHOD = 'pm_card_bypassPending';

/**
 * Cents of available balance the destination account needs before the run.
 *
 * Every destination round trip costs that account Stripe's own fee, because
 * Stripe keeps its fee on a refund while reverse_transfer pulls the whole
 * transfer back. That is $3.19 to $8.57 a row at the September amounts, across
 * ten destination rows, so the run is topped up first rather than dying two
 * thirds of the way through and leaving half a month replayed. The floor is set
 * well above the drain because running out mid-month reads as a refund-path
 * failure when it is a harness failure - which is how the first attempt at this
 * script looked, before pm_card_bypassPending.
 */
const DESTINATION_FLOAT_FLOOR_CENTS = 15_000;
const DESTINATION_FLOAT_TOPUP_CENTS = 50_000;

const RUN_ID = `replay_${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;

// ── choosing the two connected accounts ────────────────────────────────────

interface Accounts {
  destination: string;
  direct: string;
}

async function resolveAccounts(): Promise<Accounts> {
  if (PINNED_DESTINATION && PINNED_DIRECT) {
    return { destination: PINNED_DESTINATION, direct: PINNED_DIRECT };
  }
  const list = await stripe.accounts.list({ limit: 100 });
  const usable = (list.data as Array<{ id: string; charges_enabled?: boolean }>)
    .filter((a) => a.charges_enabled);
  if (usable.length < 2) {
    throw new Error(
      `need two connected test accounts with charges enabled, found ${usable.length}. ` +
        'Pass --destination-account and --direct-account.',
    );
  }
  // Sorted so two runs on the same test account pick the same pair, which makes
  // a rerun comparable to the run before it.
  const ids = usable.map((a: { id: string }) => a.id).sort();
  return {
    destination: PINNED_DESTINATION || ids[0],
    direct: PINNED_DIRECT || ids[1],
  };
}

async function availableCents(account: string): Promise<number> {
  const bal = await stripe.balance.retrieve({ stripeAccount: account });
  const available = bal.available as Array<{ currency: string; amount: number }>;
  const usd = available.find((b) => b.currency === 'usd');
  return usd?.amount ?? 0;
}

/**
 * Give the destination account enough available balance to survive the run.
 *
 * The top-up is a charge with NO application fee that is deliberately never
 * refunded, so it is not mistaken for one of the seventeen. It is tagged as
 * float in its metadata.
 */
async function ensureDestinationFloat(account: string): Promise<number> {
  const before = await availableCents(account);
  if (before >= DESTINATION_FLOAT_FLOOR_CENTS) return before;

  await stripe.paymentIntents.create({
    amount: DESTINATION_FLOAT_TOPUP_CENTS,
    currency: 'usd',
    payment_method: TEST_PAYMENT_METHOD,
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    transfer_data: { destination: account },
    metadata: { enrops_sandbox_replay: RUN_ID, enrops_replay_role: 'float_topup' },
  });
  return await availableCents(account);
}

// ── one row ────────────────────────────────────────────────────────────────

interface RowResult {
  who: string;
  day: string;
  model: SeptemberRow['model'];
  paymentIntentId: string | null;
  chargeAmountCents: number;
  /** application_fee_amount Stripe reports on the charge it created. */
  applicationFeeCentsOnCharge: number;
  /** Stripe's real processing fee from the balance transaction, as our code reads it. */
  stripeFeeCents: number;
  refundAmountCents: number;
  owedCents: number;
  owedExpectedCents: number;
  returnedCents: number;
  returnedExpectedCents: number;
  outcome: FeeReturnOutcome;
  outcomeExpected: FeeReturnOutcome;
  /** The Stripe error the fee return threw, when it threw. */
  feeErrorMessage: string | null;
  caveat: string | null;
  wordOk: boolean;
  centsOk: boolean;
  pass: boolean;
}

function stripeMessage(err: unknown): string {
  const e = err as { raw?: { message?: string }; message?: string };
  return e.raw?.message ?? e.message ?? 'unknown';
}

async function replayRow(row: SeptemberRow, accounts: Accounts): Promise<RowResult> {
  const onAccount = row.model === 'direct' ? accounts.direct : null;
  const scope = onAccount ? { stripeAccount: onAccount } : undefined;

  // ── 1. build the charge ──────────────────────────────────────────────────
  // The application fee is the one production actually took. It is NOT
  // recomputed from a rate here: recomputing it would move the fixture and the
  // expectation together and notice nothing, which is the trap the offline
  // test's canary exists to catch.
  const pi = await stripe.paymentIntents.create({
    amount: row.chargeAmountCents,
    currency: 'usd',
    payment_method: TEST_PAYMENT_METHOD,
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    ...(row.applicationFeeCents > 0 ? { application_fee_amount: row.applicationFeeCents } : {}),
    ...(row.model === 'destination'
      ? { transfer_data: { destination: accounts.destination }, on_behalf_of: accounts.destination }
      : {}),
    metadata: {
      enrops_sandbox_replay: RUN_ID,
      enrops_replay_row: row.who,
      enrops_replay_day: row.day,
    },
  }, scope);

  if (pi.livemode) {
    // Unreachable behind the sk_test_ guard above, and checked anyway: this is
    // the last point at which nothing has been refunded yet.
    throw new Error('ABORT: Stripe reports livemode on the created PaymentIntent.');
  }

  // ── 2. read the REAL numbers back, through production's own reader ───────
  const facts = await readChargeFeeFacts(stripe, pi.id, onAccount);

  // ── 3. decide the margin, through production's own arithmetic ────────────
  // remainingFraction is 1 for all seventeen: every one of these refunds
  // returned the full amount-prorated margin, which is what production's
  // proration resolved to at the time.
  const owedCents = computeMarginRefund({
    applicationFeeCents: facts.applicationFeeCents,
    stripeFeeCents: facts.stripeFeeCents,
    chargeAmountCents: facts.chargeAmountCents,
    refundAmountCents: row.refundedCents,
    alreadyRefundedFeeCents: facts.alreadyRefundedFeeCents,
    remainingFraction: 1,
  });

  // ── 4. the family's refund, in the shape refund-registration issues it ───
  await stripe.refunds.create({
    payment_intent: pi.id,
    amount: row.refundedCents,
    refund_application_fee: false,
    ...(row.model === 'destination' ? { reverse_transfer: true } : {}),
    reason: 'requested_by_customer',
    metadata: { enrops_sandbox_replay: RUN_ID, enrops_replay_row: row.who },
  }, { idempotencyKey: `${RUN_ID}_refund_${row.day}_${row.who}`, ...(scope ?? {}) });

  // ── 5. make the three failures fail, for real ────────────────────────────
  // Production's failures were an empty platform balance, which test mode
  // cannot produce (it lets the platform go negative). So the fee is exhausted
  // HERE - after the family's money has moved and before the fee return, which
  // is exactly where the 8 September failures happened - and Stripe then throws
  // on a correctly sized call. See the header: same consequence, different
  // cause, and it is not claimed to be the same cause.
  if (row.failed && facts.applicationFeeId && facts.applicationFeeCents > 0) {
    await stripe.applicationFees.createRefund(
      facts.applicationFeeId,
      { amount: facts.applicationFeeCents },
      { idempotencyKey: `${RUN_ID}_exhaust_${row.day}_${row.who}` },
    );
  }

  // ── 6. the fee return, and whether it threw ──────────────────────────────
  let returnedCents = 0;
  let feeAttemptFailed = false;
  let feeErrorMessage: string | null = null;
  if (owedCents > 0 && facts.applicationFeeId) {
    try {
      const feeRefund = await stripe.applicationFees.createRefund(
        facts.applicationFeeId,
        { amount: owedCents },
        { idempotencyKey: `${RUN_ID}_appfee_${row.day}_${row.who}` },
      );
      returnedCents = feeRefund.amount ?? owedCents;
    } catch (err) {
      returnedCents = 0;
      feeAttemptFailed = true;
      feeErrorMessage = stripeMessage(err);
    }
  }

  // ── 7. the word ──────────────────────────────────────────────────────────
  const outcome = feeReturnOutcome({
    owedCents,
    applicationFeeId: facts.applicationFeeId,
    returnedCents,
    failed: feeAttemptFailed,
  });

  const wordOk = outcome === row.expect;
  // A caveated row is exempt from the cents check and ONLY from the cents
  // check. Its word still has to be right, and the caveat is printed beside it
  // so the exemption is visible rather than assumed.
  const centsOk = row.sandboxCaveat
    ? true
    : owedCents === row.owedCents && returnedCents === row.returnedCents;

  return {
    who: row.who,
    day: row.day,
    model: row.model,
    paymentIntentId: pi.id,
    chargeAmountCents: facts.chargeAmountCents,
    applicationFeeCentsOnCharge: facts.applicationFeeCents,
    stripeFeeCents: facts.stripeFeeCents,
    refundAmountCents: row.refundedCents,
    owedCents,
    owedExpectedCents: row.owedCents,
    returnedCents,
    returnedExpectedCents: row.returnedCents,
    outcome,
    outcomeExpected: row.expect,
    feeErrorMessage,
    caveat: row.sandboxCaveat ?? null,
    wordOk,
    centsOk,
    pass: wordOk && centsOk,
  };
}

// ── the run ────────────────────────────────────────────────────────────────

// Fail before the first charge, not after the seventeenth. A missing
// --allow-write used to throw at the very end, losing the verdict line and the
// artifact on a run that had already created every charge.
if (JSON_OUT) {
  const perm = await Deno.permissions.query({ name: 'write', path: JSON_OUT });
  if (perm.state !== 'granted') {
    console.error(
      `--json=${JSON_OUT} needs write access. Re-run with --allow-write.\n` +
        'Refusing now rather than after the charges have been created.',
    );
    Deno.exit(2);
  }
}

const accounts = await resolveAccounts();
console.log(`run ${RUN_ID}`);
console.log(`destination account ${accounts.destination}`);
console.log(`direct account      ${accounts.direct}`);

const float = await ensureDestinationFloat(accounts.destination);
console.log(`destination float   ${float}c available\n`);

const results: RowResult[] = [];
for (const row of SEPTEMBER_2026) {
  // Deliberately serial. Two destination rows in flight at once share one
  // connected-account balance, and a reversal that loses that race reads as a
  // refund-path failure when it is a harness failure.
  const result = await replayRow(row, accounts);
  results.push(result);
  const mark = result.pass ? 'PASS' : 'FAIL';
  console.log(
    `${mark}  ${result.day}  ${pad(result.who, 17)} ${pad(result.model, 12)}` +
      ` charge ${padStart(String(result.chargeAmountCents), 6)}` +
      ` fee ${padStart(String(result.applicationFeeCentsOnCharge), 5)}` +
      ` stripe ${padStart(String(result.stripeFeeCents), 4)}` +
      ` refund ${padStart(String(result.refundAmountCents), 6)}` +
      ` | owed ${padStart(String(result.owedCents), 4)}/${result.owedExpectedCents}` +
      ` returned ${padStart(String(result.returnedCents), 4)}/${result.returnedExpectedCents}` +
      ` | ${pad(result.outcome, 12)} expected ${result.outcomeExpected}`,
  );
  if (result.feeErrorMessage) console.log(`      stripe said: ${result.feeErrorMessage}`);
  if (result.caveat) console.log(`      caveat: ${result.caveat}`);
}

// ── the verdict ────────────────────────────────────────────────────────────

const correctOutcomes = results.filter((r) => r.wordOk).length;
const centsMismatches = results.filter((r) => !r.centsOk);
const counted = (word: FeeReturnOutcome) => results.filter((r) => r.outcome === word).length;

console.log('');
console.log(`${correctOutcomes} of ${results.length} correct outcomes`);
console.log(
  `words: returned ${counted('returned')}/${SEPTEMBER_2026_SHAPE.returned}, ` +
    `nothing_owed ${counted('nothing_owed')}/${SEPTEMBER_2026_SHAPE.nothing_owed}, ` +
    `failed ${counted('failed')}/${SEPTEMBER_2026_SHAPE.failed}`,
);
if (centsMismatches.length) {
  console.log(`cents mismatches on ${centsMismatches.length} uncaveated row(s):`);
  for (const m of centsMismatches) {
    console.log(
      `  ${m.day} ${m.who}: owed ${m.owedCents} expected ${m.owedExpectedCents}, ` +
        `returned ${m.returnedCents} expected ${m.returnedExpectedCents}`,
    );
  }
}

const shapeOk = counted('returned') === SEPTEMBER_2026_SHAPE.returned &&
  counted('nothing_owed') === SEPTEMBER_2026_SHAPE.nothing_owed &&
  counted('failed') === SEPTEMBER_2026_SHAPE.failed;

const allPassed = correctOutcomes === results.length && centsMismatches.length === 0 && shapeOk;

if (JSON_OUT) {
  await Deno.writeTextFile(
    JSON_OUT,
    JSON.stringify({
      runId: RUN_ID,
      ranAt: new Date().toISOString(),
      accounts,
      rows: results.length,
      correctOutcomes,
      centsMismatches: centsMismatches.length,
      shapeOk,
      passed: allPassed,
      results,
    }, null, 2),
  );
  console.log(`\nwrote ${JSON_OUT}`);
}

console.log(allPassed ? '\nREPLAY PASSED' : '\nREPLAY FAILED');
Deno.exit(allPassed ? 0 : 1);
