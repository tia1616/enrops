// The Pay step quotes a family a total BEFORE it has registration ids, by
// predicting how create-checkout will spread their account credit across the
// cart. That prediction is only correct while two things agree:
//
//   1. the ORDER credit is filled in - StepPay fills `pricing.lines` in cart
//      order, create-checkout fills `registration_ids` in the order
//      create-registration pushed them;
//   2. the ARITHMETIC - greedy, each line filled before the next.
//
// Both are true today and neither is pinned by anything, which is exactly the
// shape that rots. If the two ever diverge the family is quoted a number they
// are not charged, and today's fee config hides it: at a flat 1% with no floor
// and no binding cap the total fee is linear, so ANY split gives the same
// answer. The money doc's $1.99 floor and $14.99 cap make the split matter, so
// this would first go wrong on the day pricing changes - long after the code
// that broke it.
//
// So this file pins the arithmetic directly, and pins it AT a clamped fee
// config where order genuinely changes the answer.

import { cartFeeOnLines } from './platformFee.js';
import { spreadCreditAcrossLines } from './creditSpread.js';

let failures = 0;
function check(label, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

/**
 * THE REAL CLIENT SPREAD, imported rather than copied. Both the Review step
 * and the Pay step call this exact function, so a change to it that breaks
 * agreement with the server fails here instead of quoting a family a number
 * they are not charged. An earlier draft re-implemented it in this file, which
 * would have gone on passing after the component changed.
 */
function clientSpread(grossLineAmounts, creditCents) {
  return spreadCreditAcrossLines(grossLineAmounts, creditCents).lineAmounts;
}

/**
 * The server's spread, mirroring allocateCreditAcrossLines filling in the order
 * given. Written independently rather than imported, because the server copy is
 * .ts under supabase/functions and this runner is plain node - two spellings of
 * one rule is the risk, so the test's job is to prove they still agree.
 */
function serverSpread(lines, creditCents, order) {
  const rank = new Map(order.map((id, i) => [id, i]));
  const ordered = [...lines].sort((a, b) => rank.get(a.id) - rank.get(b.id));
  let left = Math.min(creditCents, lines.reduce((s, l) => s + l.amount, 0));
  const out = new Map();
  for (const l of ordered) {
    const take = Math.min(l.amount, left);
    left -= take;
    out.set(l.id, l.amount - take);
  }
  // back into the caller's line order, which is what the fee is computed over
  return lines.map((l) => out.get(l.id));
}

// A config where the clamps BITE, so the split actually changes the fee. This
// is the money doc's section 4 shape: $1.99 floor, $14.99 card cap, per line.
// fee_pass_through is load-bearing and was missing on the first draft of this
// file: without it feeOnCents returns 0 for everything, check 1 compared 0 to 0
// and the whole suite would have passed while proving nothing.
const CLAMPED = {
  fee_pass_through: true,
  platform_fee_card_pct: 0.01,
  platform_fee_ach_pct: 0.008,
  platform_fee_floor_cents: 199,
  platform_fee_cap_cents: 1499,
  platform_fee_ach_cap_cents: 999,
};

// 1) The floor really does make the split matter - otherwise this whole file
//    proves nothing. Two ways of spreading $100 over two $100 lines: one leaves
//    [0, 10000], the other [5000, 5000]. A per-line floor charges the $1.99
//    minimum on every line that still costs something, so the second costs more.
{
  const a = cartFeeOnLines([0, 10000], CLAMPED, { isBank: false });
  const b = cartFeeOnLines([5000, 5000], CLAMPED, { isBank: false });
  check('the clamped config is order-sensitive, so this test can fail', a !== b, `${a} vs ${b}`);
}

// 2) THE REAL CHECK. Same cart, same credit: the Pay step's spread and the
//    server's spread must produce the same per-line amounts, and therefore the
//    same fee, when the server's fill order matches cart order.
{
  const gross = [24000, 18000, 9000];
  const ids = ['r1', 'r2', 'r3'];
  const lines = gross.map((amount, i) => ({ id: ids[i], amount }));
  for (const credit of [0, 1, 9000, 24000, 30000, 51000, 99999]) {
    const mine = clientSpread(gross, credit);
    const theirs = serverSpread(lines, credit, ids);
    check(`spread agrees at ${credit}`, JSON.stringify(mine) === JSON.stringify(theirs),
      JSON.stringify(mine));
    check(`fee agrees at ${credit}`,
      cartFeeOnLines(mine, CLAMPED, { isBank: false }) === cartFeeOnLines(theirs, CLAMPED, { isBank: false }));
  }
}

// 3) A VIP bundle is ONE cart item but THREE registrations. create-registration
//    expands it (children -> items -> [fall, winter, spring]) and pushes the ids
//    in that order, and pricing.js emits three lines in the same order. Pinned
//    here because the quote silently depends on it.
{
  const gross = [24000, 24000, 24000];             // fall, winter, spring
  const ids = ['vip-fall', 'vip-winter', 'vip-spring'];
  const lines = gross.map((amount, i) => ({ id: ids[i], amount }));
  const mine = clientSpread(gross, 30000);
  const theirs = serverSpread(lines, 30000, ids);
  check('a VIP bundle spreads identically on both sides',
    JSON.stringify(mine) === JSON.stringify(theirs), JSON.stringify(mine));
  check('and the credit lands on the EARLIEST terms, not spread thin',
    mine[0] === 0 && mine[1] === 18000 && mine[2] === 24000, JSON.stringify(mine));
}

// 4) If the server's order ever stops matching cart order, this test must go
//    red rather than quietly passing - proof the comparison is load-bearing.
{
  const gross = [24000, 18000];
  const ids = ['r1', 'r2'];
  const lines = gross.map((amount, i) => ({ id: ids[i], amount }));
  const mine = clientSpread(gross, 20000);
  const reversed = serverSpread(lines, 20000, ['r2', 'r1']);
  check('a mismatched fill order is detected, not tolerated',
    JSON.stringify(mine) !== JSON.stringify(reversed),
    `${JSON.stringify(mine)} vs ${JSON.stringify(reversed)}`);
}

console.log('');
console.log(failures === 0 ? 'All checks passed.' : `${failures} FAILED`);
process.exit(failures ? 1 : 0);
