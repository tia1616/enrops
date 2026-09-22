// THE RULE THAT DECIDES WHETHER WE TELL AN OPERATOR A FAMILY ALREADY HAS THE
// MESSAGE.
//
// One message can go to several classes at once. A family in two of them is
// emailed by the first and skipped by the rest, so a small class whose families
// are all in a bigger one legitimately emails nobody. Recording that as
// "nobody could be reached" - the same status as an empty roster - kept the
// class ticked on the roster list, made its history say nobody was reached, and
// left the duplicate guard silent on a re-send, because that guard only reads
// sends that reached somebody. Those families got a second copy with no warning.
//
// The claim is only safe in one direction. Saying "already covered" when it is
// false tells an operator that families who got NOTHING have the message, and
// spends the tick that would have let them retry. So every uncertain case must
// answer false.
//
// Every case below was mutation-checked: each of the three guards in
// isCoveredByEarlierClass was broken in turn and this file went red for each.

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { excludeHouseholds, isCoveredByEarlierClass } from '../familyNotify.ts';

const h = (id: string) => ({ parent_id: id, name: id, email: `${id}@example.com` });

// The case this exists for: Tuesday Chess has two families, both also in Monday
// Robotics, which emailed them first.
Deno.test('every family already emailed by an earlier class -> covered', () => {
  const afterOperator = excludeHouseholds([h('p1'), h('p2')], []);
  const remaining = excludeHouseholds(afterOperator, ['p1', 'p2']);
  assertEquals(isCoveredByEarlierClass(afterOperator, remaining, new Set(['p1', 'p2'])), true);
});

// THE FALSE POSITIVE THAT PROMPTED THE THREE-LIST SPLIT. The operator unticked
// both families by hand. Nobody was emailed anywhere, so nothing is covered -
// and telling them otherwise is the product asserting a send that never was.
Deno.test('operator unticked everybody -> NOT covered', () => {
  const afterOperator = excludeHouseholds([h('p1'), h('p2')], ['p1', 'p2']);
  const remaining = excludeHouseholds(afterOperator, []);
  assertEquals(isCoveredByEarlierClass(afterOperator, remaining, new Set()), false);
});

// ADDRESSED IS NOT REACHED. A household whose earlier send FAILED is still
// carried forward, so it is not re-aimed under this class - but nothing arrived,
// so nothing may claim it did.
Deno.test('earlier send was attempted and failed -> NOT covered', () => {
  const afterOperator = excludeHouseholds([h('p1')], []);
  const remaining = excludeHouseholds(afterOperator, ['p1']);
  assertEquals(isCoveredByEarlierClass(afterOperator, remaining, new Set()), false);
});

Deno.test('one family left to email -> NOT covered', () => {
  const afterOperator = excludeHouseholds([h('p1'), h('p2')], []);
  const remaining = excludeHouseholds(afterOperator, ['p1']);
  assertEquals(isCoveredByEarlierClass(afterOperator, remaining, new Set(['p1'])), false);
});

// THE EXCLUSION DID NOT HAPPEN, so there are still people to email.
//
// Found by mutation-checking this file: deleting the "anybody left?" guard left
// every other case here still passing, which means they were not testing it.
// This is the case that does. It is reachable whenever the batch's carried
// households fail to reach the server - an older client, a dropped field - and
// it is the dangerous direction: the class is about to email these families,
// and stamping it 'covered' would both claim they already have the message and
// spend the tick that lets the operator retry.
Deno.test('families still left to email -> NOT covered, though all were sent elsewhere', () => {
  const afterOperator = excludeHouseholds([h('p1')], []);
  const remaining = excludeHouseholds(afterOperator, []);   // carried list never arrived
  assertEquals(isCoveredByEarlierClass(afterOperator, remaining, new Set(['p1'])), false);
});

// Genuinely empty class. This is the 'no_recipients' case and must stay it.
Deno.test('nobody in the class at all -> NOT covered', () => {
  assertEquals(isCoveredByEarlierClass([], [], new Set(['p1'])), false);
});

// One unreached household is enough to refuse the claim for the whole class.
Deno.test('one of three only attempted -> NOT covered', () => {
  const afterOperator = excludeHouseholds([h('p1'), h('p2'), h('p3')], []);
  const remaining = excludeHouseholds(afterOperator, ['p1', 'p2', 'p3']);
  assertEquals(isCoveredByEarlierClass(afterOperator, remaining, new Set(['p1', 'p2'])), false);
});

// A SECOND GUARDIAN MUST NOT SPLIT THE HOUSEHOLD. Both addresses share one
// parent_id, so covering the household covers both rows - the same household key
// the exclusion uses, and the reason it is not an email address.
Deno.test('both guardians of one household -> covered by the single household id', () => {
  const all = [
    { parent_id: 'p1', name: 'Rosemary', email: 'rosemary@example.com' },
    { parent_id: 'p1', name: 'Jim', email: 'jim@example.com' },
  ];
  const afterOperator = excludeHouseholds(all, []);
  const remaining = excludeHouseholds(afterOperator, ['p1']);
  assertEquals(isCoveredByEarlierClass(afterOperator, remaining, new Set(['p1'])), true);
});
