// Pins the parent-facing prerequisite helper. Plain node script, run by
// scripts/run-src-tests.mjs.
import { cleanPrereq, buildPrereqMap, withPrerequisites, fetchPrereqMap } from './curriculumPrereqs.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
