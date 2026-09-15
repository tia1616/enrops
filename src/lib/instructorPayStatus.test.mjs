// src/lib/instructorPayStatus.test.mjs
//
// THE INVARIANT: an instructor is never told money has arrived when it has not, and
// never told money is still coming when it has already landed.
//
// WHY THIS EXISTS. From the day payouts went live until 2026-09-15, the instructor
// pay screen told every paid instructor on every provider that their money was still
// "Processing", permanently. friendlyPayStatus() switched on four statuses and let
// `default:` absorb the fifth ('paid'), which is the status 234 of prod's 247
// confirmation rows actually carry -- the normal end state of getting paid. Nothing
// failed: it built, type-checked and passed the suite, because a catch-all branch is
// indistinguishable from a deliberate one. It was found when an instructor chased
// Jessica for a $450 transfer that had settled a month earlier.
//
// The second half of the same bug was the group badge. worstPayStatus() ranked
// withheld > adjusted > pending > approved and did not rank 'paid' at all, so a camp
// week of four paid days plus one withheld day reported "Held -- contact admin" on
// $320 that had been paid. That is the dangerous direction: it tells someone to chase
// money they already have, and buries the one day that genuinely was not paid.
//
// WHAT THIS CHECKS
//   1. every status the database CHECK constraint allows has wording here
//   2. 'paid' specifically is not worded as processing (the original bug, pinned)
//   3. an unknown status returns null rather than borrowing another status's word
//   4. the group rule is true in each state that selects it, including the two
//      mixed cases that must not read the same
//   5. the four totals buckets are disjoint, total-preserving, and fail safe
//   6. the tiles in InstructorPortal.jsx cover exactly the buckets emptyStages makes
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAY_STATUSES,
  PART_PAID,
  PAY_TONES,
  groupPayStatus,
  friendlyPayStatus,
  payStage,
  distanceBonusStage,
  emptyStages,
} from './instructorPayStatus.js';

let pass = 0;
let fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
};

// 1 — THE GATE THAT WOULD HAVE CAUGHT THE ORIGINAL BUG.
// PAY_STATUSES is transcribed from session_delivery_confirmations_pay_status_check.
// If a sixth status is added to the constraint and not to this module, this fails.
ok('every database status has instructor-facing wording', () => {
  const missing = PAY_STATUSES.filter((s) => friendlyPayStatus(s) === null);
  assert.deepEqual(missing, [], `no wording for: ${missing.join(', ')}`);
});

ok('the synthetic part-paid status has wording too', () => {
  assert.notEqual(friendlyPayStatus(PART_PAID), null);
});

// 2 — the exact defect, pinned so it cannot come back by another route.
ok("'paid' is not worded as processing", () => {
  const { label } = friendlyPayStatus('paid');
  assert.equal(label, 'Paid');
  assert.notEqual(label, friendlyPayStatus('pending').label);
});

ok("'paid' does not share a colour tone with 'approved'", () => {
  // Money coming vs money arrived. Same word or same colour and the screen cannot
  // answer the only question an instructor opens it to ask.
  assert.notEqual(friendlyPayStatus('paid').tone, friendlyPayStatus('approved').tone);
});

// 3 — no silent default. This is the property that makes gate 1 meaningful: if
// unknown statuses fell back to a word, a missing status would never be visible.
ok('an unknown status returns null rather than borrowing a word', () => {
  assert.equal(friendlyPayStatus('clawed_back'), null);
  assert.equal(friendlyPayStatus(undefined), null);
  assert.equal(friendlyPayStatus(null), null);
});

// 4 — the group rule. Each assertion names the state and the sentence it must make
// true (recurring finding xii: every branch of conditional copy must be true in the
// state that selects it).
ok('a week where every day is paid reads as paid', () => {
  assert.equal(groupPayStatus(['paid', 'paid', 'paid', 'paid', 'paid']), 'paid');
});

ok('four paid days and one withheld reads as part paid, NOT held', () => {
  // Bo's week 5, Minecraft, July 2026: $320 paid, one day covered by a sub and
  // correctly zeroed. The old code said "Held -- contact admin" on all of it.
  assert.equal(groupPayStatus(['paid', 'paid', 'paid', 'paid', 'withheld']), PART_PAID);
});

ok('a mixed week with nothing paid does NOT claim part paid', () => {
  // The trap in the other direction: "Part paid" must be false here and is.
  assert.equal(groupPayStatus(['pending', 'approved']), 'pending');
  assert.equal(groupPayStatus(['approved', 'withheld']), 'withheld');
});

ok('a single status passes straight through', () => {
  for (const s of PAY_STATUSES) assert.equal(groupPayStatus([s, s]), s);
});

ok('no rows falls back to processing, never to paid', () => {
  assert.equal(groupPayStatus([]), 'pending');
  assert.equal(groupPayStatus(null), 'pending');
  assert.equal(groupPayStatus([null, undefined]), 'pending');
});

ok('an unrecognised status in a mixed group is surfaced, not swallowed', () => {
  const g = groupPayStatus(['clawed_back', 'zzz']);
  assert.equal(friendlyPayStatus(g), null, 'should reach the raw-value fallback');
});

// 5 — the buckets.
ok('every database status maps to a bucket that exists', () => {
  const buckets = Object.keys(emptyStages());
  for (const s of PAY_STATUSES) {
    assert.ok(buckets.includes(payStage(s)), `${s} -> ${payStage(s)} is not a bucket`);
  }
});

ok('paid money lands in the paid bucket, not processing', () => {
  assert.equal(payStage('paid'), 'paid');
  assert.equal(payStage('approved'), 'approved');
  assert.equal(payStage('withheld'), 'held');
  assert.equal(payStage('pending'), 'processing');
  assert.equal(payStage('adjusted'), 'processing');
});

ok('an unknown status fails SAFE - processing, never paid', () => {
  // Wrong in the direction where the instructor asks and gets good news, rather
  // than the direction where they stop chasing money they are owed.
  assert.equal(payStage('clawed_back'), 'processing');
  assert.equal(payStage(undefined), 'processing');
});

ok('the distance bonus reads its own stamp, not the day rows', () => {
  // A camp's bonus rides one payout while its days settle separately, so these
  // genuinely disagree in normal operation.
  assert.equal(distanceBonusStage('2026-08-10T14:55:56Z', 'pending'), 'paid');
  assert.equal(distanceBonusStage(null, 'paid'), 'processing');
  assert.equal(distanceBonusStage(null, 'withheld'), 'held');
  assert.equal(distanceBonusStage(null, 'approved'), 'processing');
});

ok('the buckets sum to the total for a realistic mixed week', () => {
  // Bo's week 5 Minecraft shape: 5 days at $80, one of them withheld and zeroed
  // by a -$80 adjustment, plus an unpaid $50 distance bonus.
  const rows = [
    { pay_status: 'withheld', pay_amount_cents: 8000, pay_adjustment_cents: -8000 },
    { pay_status: 'paid', pay_amount_cents: 8000, pay_adjustment_cents: 0 },
    { pay_status: 'paid', pay_amount_cents: 8000, pay_adjustment_cents: 0 },
    { pay_status: 'paid', pay_amount_cents: 8000, pay_adjustment_cents: 0 },
    { pay_status: 'paid', pay_amount_cents: 8000, pay_adjustment_cents: 0 },
  ];
  const distance = 5000;
  const stages = emptyStages();
  for (const r of rows) stages[payStage(r.pay_status)] += r.pay_amount_cents + r.pay_adjustment_cents;
  stages[distanceBonusStage(null, groupPayStatus(rows.map((r) => r.pay_status)))] += distance;

  const grand = rows.reduce((a, r) => a + r.pay_amount_cents + r.pay_adjustment_cents, 0) + distance;
  const summed = Object.values(stages).reduce((a, b) => a + b, 0);
  assert.equal(summed, grand, 'buckets must sum to the headline total');
  assert.equal(stages.paid, 32000, '$320 of paid days');
  assert.equal(stages.held, 0, 'the withheld day nets zero');
  assert.equal(stages.processing, 5000, 'the unpaid distance bonus');
});

// 6 — the tiles in the page must cover exactly the buckets the module makes. A
// bucket with no tile is money that vanishes off the screen while still counting
// toward the headline total, which is worse than the bug this change fixes.
ok('InstructorPortal tiles cover exactly the buckets emptyStages makes', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const src = readFileSync(join(here, '..', 'pages', 'portal', 'InstructorPortal.jsx'), 'utf8');
  const block = src.match(/const STAGE_TILES = \[([\s\S]*?)\];/);
  assert.ok(block, 'STAGE_TILES not found in InstructorPortal.jsx');
  const tiled = [...block[1].matchAll(/key:\s*"([a-z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(tiled, Object.keys(emptyStages()).sort());
});

// 7 — the OTHER pair of maps that must agree, and the one /code-review caught on
// 2026-09-15: every tone this module returns needs a colour in the page's palette.
// A missing one is invisible -- `color: undefined` and `background: "undefined1F"`
// are not valid CSS, so the badge simply renders unstyled and nothing errors.
ok('every tone has a colour in InstructorPortal TONE_COLOR', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const src = readFileSync(join(here, '..', 'pages', 'portal', 'InstructorPortal.jsx'), 'utf8');
  const block = src.match(/const TONE_COLOR = \{([\s\S]*?)\};/);
  assert.ok(block, 'TONE_COLOR not found in InstructorPortal.jsx');
  const coloured = [...block[1].matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]);
  const missing = PAY_TONES.filter((t) => !coloured.includes(t));
  assert.deepEqual(missing, [], `tones with no colour: ${missing.join(', ')}`);
});

ok('the old silently-defaulting helpers are gone from the page', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const src = readFileSync(join(here, '..', 'pages', 'portal', 'InstructorPortal.jsx'), 'utf8');
  assert.ok(!/function worstPayStatus/.test(src), 'worstPayStatus still defined locally');
  assert.ok(!/function friendlyPayStatus/.test(src), 'friendlyPayStatus still defined locally');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
