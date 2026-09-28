// What the family is quoted once their account credit comes off the cart, and
// how the enrops service fee reacts to the split.
//
// WHAT THIS FILE IS NOT, ANY MORE. It used to be named for client/server
// parity and it could not deliver it: the "server" it compared against was a
// hand-written mirror of allocateCreditAcrossLines living in this same file,
// so check 4 compared that copy against itself and every assertion stayed
// green if the real server changed its fill order, its id tie-break, or its
// Stripe-minimum trim. Worse, it would not have caught the bug that was live
// while it sat here passing: the Review step spelling the payment-plan gate
// differently from the Pay step.
//
// REAL PARITY NOW LIVES IN supabase/functions/_shared/tests/
// creditSpreadTwinParity.test.ts, which imports the ACTUAL server module and
// the ACTUAL browser module and compares their answers. That is the file to
// change if the split rule changes.
//
// WHAT IS LEFT HERE IS STILL WORTH HAVING, and the twin cannot do it: the fee
// is a browser-side concern on these screens, and the credit split CHANGES the
// fee once the money doc's floor and cap bite. Today's flat 1% with no floor
// and no binding cap makes the total fee linear, so any split gives the same
// answer and a divergence would hide until the day pricing changes. So this
// pins the fee against a CLAMPED config where the split genuinely matters.

import { cartFeeOnLines } from './platformFee.js';
import { spreadCreditAcrossLines } from './creditSpread.js';

let failures = 0;
function check(label, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
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

// 2) THE FEE FOLLOWS THE CREDIT DOWN. The money doc's rule is that the fee is
//    charged once per dollar of FAMILY money, so a line the credit zeroes must
//    stop carrying a fee - including its per-line floor, which is the part that
//    would otherwise keep charging $1.99 for a class that now costs nothing.
{
  const gross = [24000, 18000, 9000];
  const full = cartFeeOnLines(gross, CLAMPED, { isBank: false });
  let prev = full;
  for (const credit of [9000, 24000, 30000, 51000]) {
    const { lineAmounts } = spreadCreditAcrossLines(gross, credit);
    const fee = cartFeeOnLines(lineAmounts, CLAMPED, { isBank: false });
    check(`more credit never costs more fee (credit ${credit})`, fee <= prev, `${fee} <= ${prev}`);
    prev = fee;
  }
  const { lineAmounts: allCovered } = spreadCreditAcrossLines(gross, 51000);
  check('a fully covered cart carries no fee at all',
    cartFeeOnLines(allCovered, CLAMPED, { isBank: false }) === 0);
}

// 3) A VIP bundle is ONE cart item but THREE registrations, and the credit
//    lands on the EARLIEST terms rather than being spread thin - one sentence
//    a parent can be told ("it covered Fall, and $60 of Winter").
{
  const { lineAmounts, creditApplied } = spreadCreditAcrossLines([24000, 24000, 24000], 30000);
  check('a VIP bundle fills earliest-first',
    JSON.stringify(lineAmounts) === JSON.stringify([0, 18000, 24000]), JSON.stringify(lineAmounts));
  check('and spends exactly what was offered', creditApplied === 30000, String(creditApplied));
}

// 4) THE STRIPE FLOOR. Credit that would leave 1-49 cents owing is trimmed so
//    the family pays the 50-cent minimum and keeps the rest, because Stripe
//    refuses the charge otherwise and the retry loop that produced had no exit.
{
  const { lineAmounts, creditApplied } = spreadCreditAcrossLines([22800], 22780);
  check('a sub-50c residual is trimmed away, not sent to Stripe',
    lineAmounts[0] === 50 && creditApplied === 22750,
    `owed ${lineAmounts[0]}, spent ${creditApplied}`);
  const exact = spreadCreditAcrossLines([22800], 22800);
  check('and covering the cart outright still goes to zero',
    exact.lineAmounts[0] === 0 && exact.creditApplied === 22800);
}

console.log('');
console.log(failures === 0 ? 'All checks passed.' : `${failures} FAILED`);
process.exit(failures ? 1 : 0);
