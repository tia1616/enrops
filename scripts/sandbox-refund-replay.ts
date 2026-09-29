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
// HOW MUCH OF THIS STOPS BEING MINE, honestly, because it is not uniform and an
// earlier draft of this header claimed it was.
//
// On the TEN destination rows the Stripe fee comes off the real balance
// transaction, so the margin is genuinely discovered: change the arithmetic and
// the numbers move. That is where the falsification power is.
//
// On the SEVEN direct rows readChargeFeeFacts nets off nothing by design
// (Stripe billed the operator), so the margin reduces to the application fee -
// and that fee is a number this script SET on the charge from the table. Those
// rows prove the code reads Stripe correctly and the direct path takes no fee
// off; they cannot tell you the table's fee matches what production charged.
// Four of them (Rosenau, Wittmayer, Calcagno, Burke) rest on a fee marked
// `appFeeSource: 'derived'`, which is printed beside every row for exactly this
// reason. Nelson and Schmitt are pinned independently by the offline fixtures.
//
// Everywhere: the fee return is a real applicationFees.createRefund, the three
// failures throw a real Stripe error, and the charge Stripe built is asserted
// to be the charge the row asked for before anything is computed from it.
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
// instead of discovering them. Pin BOTH or neither: one pin plus discovery can
// resolve the two roles to the same account, so it is refused.
//
// ARGUMENT HANDLING REFUSES RATHER THAN IGNORES, in all four shapes: an
// unrecognised or mistyped flag name, a value with no flag (the
// space-instead-of-equals mistake), a value-taking flag given with no value,
// and a value on `--dry-run`, which is a bare boolean and takes none. Every one
// of those used to be swallowed somewhere, and a swallowed argument reads as a
// run that was configured the way the operator intended when it was not.
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
//     where production owed 371. Her outcome word is unaffected.
//
// THAT ROW IS STILL CHECKED TO THE CENT. It says what the sandbox SHOULD owe
// (285, in `sandboxOwedCents`) and is held to it. An earlier version let a
// caveat suspend the amount check altogether, and that was blind to the whole
// over-refund class below: her figure moved to 1142 under mutation and the row
// still said PASS. A divergence we can predict exactly gets asserted exactly.
//
// So every row is expected to match to the cent, and ANY cents mismatch FAILS
// the run. "Seventeen correct outcomes" is the bar, but a right word over a
// wrong amount is not a result worth having.
//
// AND THAT IS NOT A PEDANTIC ADDITION - the doc's bar, taken literally, is not
// enough. Proved by mutation on 2026-09-29: dropping the balance_transaction
// expansion from chargeFeeFacts (the silent over-refund the offline test
// documents as a FINDING) still produces SEVENTEEN CORRECT OUTCOMES. It flags
// EIGHT rows on cents, six of which really moved the money: 207 + 620 + 857 +
// 726 + 319 + 857 = $35.86 handed back over and above the margin, out of
// enrops's own pocket. (Seven, in an earlier version of this paragraph, was
// measured before the caveated row stopped being exempt; that row is the
// eighth.) Only the cents check catches any of it.
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
// before believing a green run.
//
// THE KNOWN DIFFERENCES ARE FIVE, NOT TWO. This list is the map of what a green
// run means, so it is worth more than it costs to keep complete:
//  1. `remainingFraction` is pinned to 1 (it was 1 for all seventeen), so the
//     COMPOSITION of proration with the margin split is never exercised here.
//     refundFeeProration.test.ts covers the proration itself.
//  2. Production gates reverse_transfer on the charge really having a transfer;
//     every destination charge built here does.
//  3. Production gates the whole fee path on `feeRefundApplies`
//     (refund-registration/index.ts:1862). This script has no equivalent, so a
//     regression in that gate is invisible to the replay. Every live org is
//     'tenant' today, which is why it is inert rather than wrong.
//  4. Production refunds PER PAYMENT INTENT across an instalment plan; every row
//     here is one standalone charge, so `alreadyRefundedFeeCents` is always 0
//     and the double-refund ceiling in refundFeeSplit.ts is never reached -
//     even though Leila Banks really was instalment 1 of 3.
//  5. This script sets `on_behalf_of` on every destination charge. Production
//     sets it only when `instructor_pay_model === 'enrops_platform'`
//     (connectChargeParams.ts:120), and J2S - which is all ten destination rows
//     - is deliberately NOT that, so the real charges did not carry it. It does
//     not move the money (Stripe debits the platform on a destination charge
//     either way, recorded in stripe-webhook), but the shape differs.

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

function readFlag(name: string): string | null {
  const hit = Deno.args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const eq = hit.indexOf('=');
  return eq === -1 ? '' : hit.slice(eq + 1);
}

/**
 * Every argument this script understands, read in one place.
 *
 * THE KEY IS THE READER, deliberately. An earlier version kept a separate
 * KNOWN_FLAGS list, which closed the drift in one direction only - asking for an
 * unlisted flag became a compile error, but ADDING a name to the list and
 * forgetting to wire a reader would have been accepted and silently ignored,
 * which is the exact bug the list was added to fix ("an ignored pin reads as a
 * pinned run"). Here a name cannot exist without being read, because naming it
 * IS reading it.
 *
 * `null` means absent, `''` means given with no value.
 */
const ARGS = {
  'dry-run': readFlag('dry-run'),
  'json': readFlag('json'),
  'destination-account': readFlag('destination-account'),
  'direct-account': readFlag('direct-account'),
} as const;

const KNOWN_FLAGS = Object.keys(ARGS);

// EVERY ARGUMENT IS ACCOUNTED FOR, and this is the last member of a family that
// bit twice. A bare `--json` parsed as the empty string and silently skipped the
// artifact; one account pin plus discovery could resolve both roles to one
// account. The survivor was a MISTYPED NAME: `--destination_account=acct_X` with
// underscores matched nothing, so both pins read as null, the both-or-neither
// check was satisfied BECAUSE NEITHER WAS SET, and discovery quietly picked its
// own two accounts while the operator believed they had pinned them.
//
// The two shapes get DIFFERENT messages on purpose. Lumping them together made
// `--json out.json` - the space-instead-of-equals mistake that caused the silent
// run in the first place - report "unrecognised argument: out.json", blaming the
// one token the operator typed correctly.
const stray = Deno.args.filter((a) => !a.startsWith('--'));
if (stray.length) {
  console.error(
    `value with no flag: ${stray.join(' ')}\n` +
      'Every flag takes its value with an equals sign, e.g. --json=path.json',
  );
  Deno.exit(2);
}
const unrecognised = Deno.args.filter((a) =>
  !KNOWN_FLAGS.some((k) => a === `--${k}` || a.startsWith(`--${k}=`))
);
if (unrecognised.length) {
  console.error(
    `unrecognised argument(s): ${unrecognised.join(' ')}\n` +
      `this script takes only: ${KNOWN_FLAGS.map((f) => `--${f}`).join(', ')}\n` +
      'Refusing rather than ignoring them - an ignored pin reads as a pinned run.',
  );
  Deno.exit(2);
}

// `--dry-run` IS A BOOLEAN AND TAKES NO VALUE. `--dry-run=false` used to enable
// the dry run and exit 0 - the same exit code a genuine REPLAY PASSED produces -
// so anything gating on the status rather than reading the banner recorded a
// pass for a run that never touched Stripe. Loud on a terminal, silent in a
// wrapper.
if (ARGS['dry-run'] !== null && ARGS['dry-run'] !== '') {
  console.error(
    '--dry-run takes no value. Pass --dry-run to print the plan, or leave it off to run.',
  );
  Deno.exit(2);
}

// A VALUE-TAKING FLAG GIVEN WITHOUT ITS VALUE IS A TYPO, NOT A DEFAULT.
// `--json` alone parsed as the empty string, which is falsy, so both the
// write-permission pre-check and the write itself were skipped in silence:
// seventeen real charges, "REPLAY PASSED", and no artifact, with nothing said.
for (const name of ['json', 'destination-account', 'direct-account'] as const) {
  if (ARGS[name] === '') {
    console.error(`--${name} needs a value, e.g. --${name}=<value>. Refusing rather than ignoring it.`);
    Deno.exit(2);
  }
}

const DRY_RUN = ARGS['dry-run'] !== null;
const JSON_OUT = ARGS.json;
const PINNED_DESTINATION = ARGS['destination-account'];
const PINNED_DIRECT = ARGS['direct-account'];

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
  // BOTH PINS OR NEITHER. Honouring one pin and discovering the other used to
  // be allowed, and it could resolve both roles to the SAME account: pin only
  // the destination, and if that id happens to sort into the slot discovery
  // would pick for direct, every direct row is created on the destination
  // account and the run still reports PASS.
  //
  // What that costs is realism rather than coverage, and the distinction is
  // worth keeping straight: the asymmetry the seven direct rows test turns on
  // `onAccount` being non-null (which decides whether readChargeFeeFacts nets
  // off Stripe's fee), not on WHICH account it is. One account for both roles
  // would still exercise both code paths - it just would not be two businesses.
  // Refuse anyway; a replay that quietly stops being what it says it is has
  // already lost its value as evidence.
  //
  // The empty-value case is caught centrally at the top of the file.
  if ((PINNED_DESTINATION === null) !== (PINNED_DIRECT === null)) {
    throw new Error(
      'pin BOTH accounts or neither. One pin plus discovery can resolve the ' +
        'destination and direct roles to the same account, which silently stops ' +
        'the two charge models being two accounts.',
    );
  }
  if (PINNED_DESTINATION && PINNED_DIRECT) {
    if (PINNED_DESTINATION === PINNED_DIRECT) {
      throw new Error('the destination and direct accounts must be different');
    }
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
  // Both come from discovery here - the pinned paths all returned above - so the
  // two are different by construction, and asserted rather than assumed.
  const resolved = { destination: ids[0], direct: ids[1] };
  if (resolved.destination === resolved.direct) {
    throw new Error('discovery resolved both roles to the same account');
  }
  return resolved;
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

  // CHECK THE TOP-UP ACTUALLY CLEARED THE FLOOR. One top-up is not enough if
  // the account starts deeply negative from an aborted earlier run, and
  // proceeding anyway means dying around row six with "the recipient of this
  // transfer does not have sufficient funds" - the very error the comment above
  // warns reads like a refund-path defect and is not one - after ten real
  // charges have been created. Refuse here instead, while none of the seventeen
  // has been replayed. (The float top-up charge above HAS been created by this
  // point, and carries no idempotency key, so each retry of a run that trips
  // this guard leaves another one behind. Test mode, tagged as float in its
  // metadata, and never refunded - but "nothing has moved" would be false.)
  const after = await availableCents(account);
  if (after < DESTINATION_FLOAT_FLOOR_CENTS) {
    throw new Error(
      `destination account ${account} is at ${after}c after a ${DESTINATION_FLOAT_TOPUP_CENTS}c ` +
        `top-up, still below the ${DESTINATION_FLOAT_FLOOR_CENTS}c floor. Top it up by hand ` +
        'before replaying, rather than failing part way through the month.',
    );
  }
  return after;
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
  /**
   * Where that fee figure came from. Carried into the result on purpose: on a
   * direct row the margin reduces to the application fee, so a row whose fee is
   * 'derived' is proving the code path, not the number. Printed beside the row
   * rather than left to the header.
   */
  appFeeSource: SeptemberRow['appFeeSource'];
  /** Stripe's real processing fee from the balance transaction, as our code reads it. */
  stripeFeeCents: number;
  refundAmountCents: number;
  owedCents: number;
  /** What the SANDBOX should owe: production's figure unless the row diverges. */
  owedExpectedCents: number;
  /** What production owed on the day. Differs from the above on the Link row. */
  productionOwedCents: number;
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

  // THE CHARGE STRIPE BUILT MUST BE THE CHARGE THE ROW ASKED FOR. These two
  // numbers were read back off Stripe's object and then used as inputs to the
  // arithmetic without ever being compared to what was requested, so a
  // parameter Stripe clamped, adjusted or ignored would have been absorbed
  // silently and the row's verdict computed against a charge nobody asked for.
  // Every printed figure downstream describes a charge; assert it is the right
  // one before describing it.
  if (facts.chargeAmountCents !== row.chargeAmountCents) {
    throw new Error(
      `${row.who}: asked Stripe for a ${row.chargeAmountCents}c charge and got ` +
        `${facts.chargeAmountCents}c. The row cannot be replayed against a different charge.`,
    );
  }
  if (facts.applicationFeeCents !== row.applicationFeeCents) {
    throw new Error(
      `${row.who}: asked for a ${row.applicationFeeCents}c application fee and Stripe ` +
        `recorded ${facts.applicationFeeCents}c.`,
    );
  }

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
  const stripeRefund = await stripe.refunds.create({
    payment_intent: pi.id,
    amount: row.refundedCents,
    refund_application_fee: false,
    ...(row.model === 'destination' ? { reverse_transfer: true } : {}),
    reason: 'requested_by_customer',
    metadata: { enrops_sandbox_replay: RUN_ID, enrops_replay_row: row.who },
  }, { idempotencyKey: `${RUN_ID}_refund_${row.day}_${row.who}`, ...(scope ?? {}) });

  // THE REFUND'S STATUS IS READ, NOT ASSUMED. refunds.create resolves rather
  // than throwing on a refund that is pending or failed, and every word this
  // script prints is a claim about what happened AFTER the family's money moved.
  // Scoring a fee return as 'returned' on a refund that never completed would
  // make the artifact say the opposite of the truth. Production does not check
  // this either, but production is backstopped by stripe-webhook, which reads
  // refund.status; nothing backstops a script.
  if (stripeRefund.status !== 'succeeded') {
    throw new Error(
      `${row.who}: Stripe returned refund ${stripeRefund.id} with status ` +
        `"${stripeRefund.status}", so the family's money did not move and the ` +
        'fee return below would be scored against a refund that did not happen.',
    );
  }

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
    let feeCallSucceeded = false;
    let observedAmount: unknown = undefined;
    try {
      const feeRefund = await stripe.applicationFees.createRefund(
        facts.applicationFeeId,
        { amount: owedCents },
        { idempotencyKey: `${RUN_ID}_appfee_${row.day}_${row.who}` },
      );
      observedAmount = feeRefund.amount;
      feeCallSucceeded = true;
    } catch (err) {
      // A STRIPE REJECTION AND A BROKEN HARNESS ARE NOT THE SAME EVENT, and
      // this catch used to treat them as one. On the three rows that expect
      // 'failed', every field already matches by construction - owed is right,
      // returned is 0, the word is 'failed' - so a rate limit, a dropped
      // connection or an idempotency conflict at this exact call scored as
      // "failed as expected" and the entire failure-path evidence, three of the
      // seventeen rows, passed on a harness fault.
      //
      // The deliberate failure above is Stripe REJECTING a correctly sized call
      // (invalid_request_error: the fee is already fully refunded). Anything
      // else is the harness breaking and must stop the run rather than be
      // scored.
      const type = (err as { raw?: { type?: string }; type?: string });
      const errType = type.raw?.type ?? type.type ?? '';
      if (row.failed && errType !== 'invalid_request_error') {
        throw new Error(
          `${row.who}: the fee return failed with "${errType || 'unknown'}" - ` +
            `${stripeMessage(err)}. That is the harness breaking, not Stripe rejecting ` +
            'the call, and it must not be scored as the expected failure.',
        );
      }
      returnedCents = 0;
      feeAttemptFailed = true;
      feeErrorMessage = stripeMessage(err);
    }

    // OBSERVED, NOT ASSUMED - AND CHECKED OUTSIDE THE try ON PURPOSE.
    //
    // `returnedCents` used to fall back to `owedCents`, the number we ASKED
    // for, which is the request compared against the table rather than against
    // Stripe. The first attempt at fixing that threw from INSIDE the try above,
    // where the catch immediately swallowed it and re-scored the row as "the
    // fee return threw" - on TWELVE rows it printed my own error text as though
    // Stripe had said it, and on the three `failed` rows it escaped only because
    // a plain Error has no `.type`. (Twelve, not fourteen: the month is 12
    // affected + 3 escaping + 2 that never reach this block at all, because
    // Dillard and Snowley carry no application fee. A blast radius that does not
    // survive counting is the kind of number this file has already had to
    // correct once.) A guard that works by accident is not a guard, and a guard
    // inside the try it guards is not outside it.
    //
    // Stripe accepting the call and returning an unreadable figure is not a
    // failed fee return. It is the run having nothing to report, so it stops.
    if (feeCallSucceeded) {
      if (typeof observedAmount !== 'number') {
        throw new Error(
          `${row.who}: Stripe accepted the fee refund but returned no readable amount ` +
            `(${JSON.stringify(observedAmount)}), so there is no observed figure to report.`,
        );
      }
      returnedCents = observedAmount;
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
  // NO ROW IS EXEMPT FROM THE AMOUNT CHECK. A caveated row used to be, and that
  // exemption was blind to exactly the class this replay exists to catch: under
  // the mutation that drops the balance_transaction expansion, Laura Lillison's
  // row computed 1142 instead of 285 - an $11.42 over-refund - and still printed
  // PASS while six other rows caught the same bug.
  //
  // So a row that cannot reproduce production says what it CAN reproduce, to the
  // cent, in `sandboxOwedCents`, and is held to that. The caveat now explains a
  // number rather than suspending one.
  const owedExpectedCents = row.sandboxOwedCents ?? row.owedCents;
  const centsOk = owedCents === owedExpectedCents && returnedCents === row.returnedCents;

  return {
    who: row.who,
    day: row.day,
    model: row.model,
    paymentIntentId: pi.id,
    chargeAmountCents: facts.chargeAmountCents,
    applicationFeeCentsOnCharge: facts.applicationFeeCents,
    appFeeSource: row.appFeeSource,
    stripeFeeCents: facts.stripeFeeCents,
    refundAmountCents: row.refundedCents,
    owedCents,
    owedExpectedCents,
    /** Production's own figure, kept beside the sandbox's when they differ. */
    productionOwedCents: row.owedCents,
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

  // STAMP THE ARTIFACT AS UNFINISHED BEFORE THE FIRST CHARGE.
  //
  // Every guard in this script throws, and a throw skips the write at the end -
  // correctly, since there is no verdict to write. But it also LEAVES THE
  // PREVIOUS RUN'S FILE at that path, so someone opening it after a run that
  // died reads a stale `"passed": true` and believes it describes today. For a
  // file whose entire job is to say whether the money came back, a stale pass is
  // the worst thing it can say. Writing `passed: false` now means a crashed run
  // leaves a file that is honest about having no result.
  await Deno.writeTextFile(
    JSON_OUT,
    JSON.stringify({
      runId: RUN_ID,
      startedAt: new Date().toISOString(),
      status: 'started',
      passed: false,
      note: 'This run did not finish. A completed run overwrites this file.',
    }, null, 2),
  );
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
      `(${result.appFeeSource.slice(0, 4)})` +
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

// SEVENTEEN IS WRITTEN HERE AS A LITERAL, in the script, because the script is
// what produces the artifact anyone quotes.
//
// The gate sentence is "17 correct outcomes". Everything else the verdict reads
// - the table and the shape constant - lives in one imported file, so deleting
// an awkward row and decrementing the matching constant used to print
// "16 of 16 correct outcomes / REPLAY PASSED" and write `"passed": true`. The
// outside witness added in the last round went into the TEST file, which is a
// different command nobody is required to run alongside this one. That was the
// same finding, half fixed.
const EXPECTED_ROWS = 17;
const rowCountOk = results.length === EXPECTED_ROWS &&
  SEPTEMBER_2026_SHAPE.rows === EXPECTED_ROWS;

const shapeOk = counted('returned') === SEPTEMBER_2026_SHAPE.returned &&
  counted('nothing_owed') === SEPTEMBER_2026_SHAPE.nothing_owed &&
  counted('failed') === SEPTEMBER_2026_SHAPE.failed;

const allPassed = rowCountOk &&
  correctOutcomes === results.length &&
  centsMismatches.length === 0 &&
  shapeOk;

// THE HEADLINE IS THE SENTENCE THAT GETS QUOTED, so it must not read as the
// money layer's sign-off unless the run actually earned it. "N of N correct
// outcomes" is word-for-word the doc's definition of done, and it used to print
// on a FAILING run: the mutation run showed "17 of 17 correct outcomes"
// directly above "REPLAY FAILED", with $35.86 over-returned on six charges.
// Anyone pasting that line into a status update would sign blocker 1 off on a
// failure. On a failed run the count is still shown, because it is useful, but
// it is not allowed to stand as the claim.
console.log('');
if (allPassed) {
  console.log(`${correctOutcomes} of ${results.length} correct outcomes`);
} else {
  console.log(
    `NOT A PASS. ${correctOutcomes} of ${results.length} outcome WORDS are correct, ` +
      'which is not the same as correct outcomes - see the failures below.',
  );
  if (!rowCountOk) {
    console.log(
      `  and this is not the month: ${results.length} rows replayed against a table ` +
        `declaring ${SEPTEMBER_2026_SHAPE.rows}, where the definition of done names ${EXPECTED_ROWS}.`,
    );
  }
}
console.log(
  `words: returned ${counted('returned')}/${SEPTEMBER_2026_SHAPE.returned}, ` +
    `nothing_owed ${counted('nothing_owed')}/${SEPTEMBER_2026_SHAPE.nothing_owed}, ` +
    `failed ${counted('failed')}/${SEPTEMBER_2026_SHAPE.failed}`,
);
if (centsMismatches.length) {
  console.log(`cents mismatches on ${centsMismatches.length} row(s):`);
  for (const m of centsMismatches) {
    console.log(
      `  ${m.day} ${m.who}: owed ${m.owedCents} expected ${m.owedExpectedCents}, ` +
        `returned ${m.returnedCents} expected ${m.returnedExpectedCents}`,
    );
  }
}

if (JSON_OUT) {
  await Deno.writeTextFile(
    JSON_OUT,
    JSON.stringify({
      runId: RUN_ID,
      ranAt: new Date().toISOString(),
      accounts,
      rows: results.length,
      expectedRows: EXPECTED_ROWS,
      rowCountOk,
      // DELIBERATELY NOT CALLED `correctOutcomes`. The console was taught not
      // to print "N of N correct outcomes" on a failing run, and the artifact
      // - which is the machine-readable half, and the easier one to quote -
      // went on emitting exactly that field beside `passed: false`. A field
      // name is a claim too. This one says only what it counts.
      outcomeWordsCorrect: correctOutcomes,
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
