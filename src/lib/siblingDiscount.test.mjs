// Pins WHO gets the sibling discount on the registration screen: each child
// after the first child who is actually registering. Not "anyone in slot 1+".
//
// The bug this guards: a family adds a second child, then removes every class
// from the first. One child is registering, and that child used to be shown
// (and charged) the sibling discount because they sat in slot 1. The server
// twin is siblingRank in supabase/functions/create-registration; the two must
// agree or the family sees one price and is charged another.

import { calculateCart } from './pricing.js';

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${actual}, expected ${expected})`}`);
}

const program = (id) => ({ id, price_cents: 20000, early_bird_price_cents: null, early_bird_deadline: null });
const child = (i, items) => ({ child_index: i, items: items.map((id) => ({ program: program(id), isVip: false })) });
const siblingCents = (children) =>
  calculateCart({ children, sibling_discount_pct: 10 }).sibling_total_cents;

check('one child in slot 0: no discount', siblingCents([child(0, ['a'])]), 0);
check('two children registering: second gets 10%', siblingCents([child(0, ['a']), child(1, ['b'])]), 2000);
check('first slot emptied, one child left in slot 1: no discount',
  siblingCents([child(0, []), child(1, ['b'])]), 0);
check('empty middle slot: third child is still a sibling of the first',
  siblingCents([child(0, ['a']), child(1, []), child(2, ['c'])]), 2000);
check('sibling discount off for the business: nothing',
  calculateCart({ children: [child(0, ['a']), child(1, ['b'])], sibling_discount_pct: null }).sibling_total_cents, 0);

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nALL PASS');
