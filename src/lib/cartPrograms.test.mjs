// Pins the cart -> program join. Repo convention: plain node script with a
// pass/fail counter, run by scripts/run-src-tests.mjs.
//
// This join had NO test when it was written, because it lived inside a .jsx file
// the runner cannot import - and the two screens that needed it had already drifted
// apart: the review screen walked the VIP bundle legs, the student step did not.
import { programsInItem, programsForChild, programForLine } from './cartPrograms.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`); }
}

const fall = { id: 'p-fall', term: 'FA26' };
const winter = { id: 'p-winter', term: 'WI27' };
const spring = { id: 'p-spring', term: 'SP27' };
const plain = { id: 'p-plain' };

// --- programsInItem -----------------------------------------------------------
eq('a plain item is its one program',
  programsInItem({ program: plain, isVip: false }).map((p) => p.id), ['p-plain']);

// THE CASE THAT WAS BEING MISSED. item.program is only the Fall leg, so reading it
// alone ignores two thirds of what a VIP family is buying.
eq('a VIP bundle yields all three terms',
  programsInItem({ program: fall, isVip: true, vipBundle: { fall, winter, spring } }).map((p) => p.id),
  ['p-fall', 'p-winter', 'p-spring']);
// Fall is usually the SAME row as item.program; a caller must not see it twice.
eq('the Fall leg is not double-counted',
  programsInItem({ program: fall, isVip: true, vipBundle: { fall, winter, spring } }).length, 3);
// A bundle that never loaded Winter/Spring must not put holes in the list -
// pricing.js already guards `if (!prog) return`, and this agrees with it.
eq('a half-built bundle skips the missing legs',
  programsInItem({ program: fall, isVip: true, vipBundle: { fall, winter: null, spring: undefined } }).map((p) => p.id),
  ['p-fall']);
eq('no item is an empty list', programsInItem(null), []);
eq('an item with no program at all is an empty list', programsInItem({ isVip: false }), []);

// --- programsForChild ---------------------------------------------------------
eq('a child with no items', programsForChild({}), []);
eq('a child with a null items field', programsForChild({ items: null }), []);
eq('no child at all', programsForChild(undefined), []);
eq('a child with one plain item',
  programsForChild({ items: [{ program: plain }] }).map((p) => p.id), ['p-plain']);

// --- programForLine -----------------------------------------------------------
const vipChild = { items: [{ program: fall, isVip: true, vipBundle: { fall, winter, spring } }] };

eq('matches the plain line',
  programForLine({ items: [{ program: plain }] }, { program_id: 'p-plain' })?.id, 'p-plain');
// EACH VIP LINE CARRIES ITS OWN program_id. Matching only item.program would find
// nothing for two lines out of three.
eq('matches the VIP Fall line', programForLine(vipChild, { program_id: 'p-fall' })?.id, 'p-fall');
eq('matches the VIP Winter line', programForLine(vipChild, { program_id: 'p-winter' })?.id, 'p-winter');
eq('matches the VIP Spring line', programForLine(vipChild, { program_id: 'p-spring' })?.id, 'p-spring');

// Fails to null rather than guessing. A restored cart whose programs were refetched
// under new rows must render nothing, not the wrong class's range.
eq('an unknown program_id is null', programForLine(vipChild, { program_id: 'p-nope' }), null);
eq('a line with no program_id is null', programForLine(vipChild, {}), null);
eq('no line is null', programForLine(vipChild, null), null);
eq('no child is null', programForLine(null, { program_id: 'p-fall' }), null);
// A line whose program_id is undefined must not match a program whose id is also
// undefined - that would attach a warning to an arbitrary row.
eq('undefined never matches undefined',
  programForLine({ items: [{ program: { id: undefined } }] }, { program_id: undefined }), null);

console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
