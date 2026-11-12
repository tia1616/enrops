// Pins the parent-facing prerequisite helper. Plain node script, run by
// scripts/run-src-tests.mjs.
import { cleanPrereq, buildPrereqMap, withPrerequisites, fetchPrereqMap, prereqsOncePerBundle } from './curriculumPrereqs.js';
import { calculateCart } from './pricing.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`); }
}

eq('trims text', cleanPrereq('  Level 1 not required.  '), 'Level 1 not required.');
eq('blank is none', cleanPrereq('   '), null);
eq('null is none', cleanPrereq(null), null);
eq('non-string is none', cleanPrereq(5), null);

const map = buildPrereqMap([
  { id: 'a', prerequisites: 'This is Level 2.' },
  { id: 'b', prerequisites: '  ' },
  { id: 'c', prerequisites: null },
]);
eq('only non-blank curricula land in the map', [...map.entries()], [['a', 'This is Level 2.']]);

const out = withPrerequisites(
  [{ id: 1, curriculum_id: 'a' }, { id: 2, curriculum_id: 'b' }, { id: 3, curriculum_id: null }, { id: 4 }],
  map,
);
eq('matching curriculum gets the line', out[0].prerequisites, 'This is Level 2.');
eq('blank curriculum gets null', out[1].prerequisites, null);
eq('null curriculum_id gets null', out[2].prerequisites, null);
eq('missing curriculum_id gets null', out[3].prerequisites, null);
eq('other fields untouched', out[0].id, 1);
eq('null programs is safe', withPrerequisites(null, map), []);
eq('missing map is safe', withPrerequisites([{ curriculum_id: 'a' }], undefined)[0].prerequisites, null);

// Soft-fail: a read error must not break the page, it just shows no line.
const errSb = { from: () => ({ select: () => ({ eq: () => ({ not: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) };
const origWarn = console.warn; console.warn = () => {};
eq('read error gives empty map', (await fetchPrereqMap(errSb, 'o')).size, 0);
const throwSb = { from: () => { throw new Error('x'); } };
eq('thrown error gives empty map', (await fetchPrereqMap(throwSb, 'o')).size, 0);
console.warn = origWarn;
const okSb = { from: () => ({ select: () => ({ eq: () => ({ not: async () => ({ data: [{ id: 'a', prerequisites: 'x' }], error: null }) }) }) }) };
eq('good read builds the map', [...(await fetchPrereqMap(okSb, 'o')).entries()], [['a', 'x']]);

// Bundle: each prerequisite said once across Fall/Winter/Spring.
eq('bundle: same text on all legs shows once', prereqsOncePerBundle(['R', 'R', 'R']), ['R', null, null]);
eq('bundle: Level 2 winter leg shows its own line', prereqsOncePerBundle(['R', 'L2', 'R']), ['R', 'L2', null]);
eq('bundle: fall without one, winter with one', prereqsOncePerBundle([null, 'L2', 'L2']), [null, 'L2', null]);
eq('bundle: blanks are none', prereqsOncePerBundle(['  ', null, 'x']), [null, null, 'x']);

// The review line reads the program's curriculum_id - the cart line must carry
// it on standard AND VIP lines, or the review screen silently loses the line.
const prog = (id, term, cid) => ({ id, term, curriculum: 'C', curriculum_id: cid, price_cents: 10000, day_of_week: 'Monday', session_count: 8 });
const one = calculateCart({
  children: [{ child_index: 0, student: {}, items: [{ program: prog('p1', 'WI27', 'cur-a'), isVip: false }] }],
  active_child_index: 0,
});
eq('cart: standard line carries curriculum_id', one.lines.map((l) => l.curriculum_id), ['cur-a']);
const vip = calculateCart({
  children: [{ child_index: 0, student: {}, items: [{
    program: prog('f', 'FA26', 'cur-a'), isVip: true,
    vipBundle: { fall: prog('f', 'FA26', 'cur-a'), winter: prog('w', 'WI27', 'cur-b'), spring: prog('s', 'SP27', 'cur-a') },
  }] }],
  active_child_index: 0,
  vip_enabled: true,
});
eq('cart: VIP lines each carry their own leg curriculum_id', vip.lines.map((l) => l.curriculum_id), ['cur-a', 'cur-b', 'cur-a']);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
