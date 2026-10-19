// Pins how the registration page says where a camp is.
// Repo convention: plain node script with a pass/fail counter, run by
// scripts/run-src-tests.mjs.
import { groupCampsByArea, campWhereLabel, NO_AREA_HEADING } from './campAreas.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`); }
}

const camp = (id, area, name = `Venue ${id}`, address = null) => ({
  id, program_locations: { name, area, address },
});
const shape = (groups) => groups.map((g) => [g.heading, g.items.map((p) => p.id)]);

// --- grouping ---------------------------------------------------------------
// Shaped like J2S's winter 2027 camps on prod: five cities, Vancouver twice.
eq('cities alphabetical, order kept within a city',
  shape(groupCampsByArea([
    camp('m1', 'Vancouver'), camp('f1', 'Vancouver'), camp('b1', 'Beaverton'),
    camp('h1', 'Happy Valley'), camp('m2', 'Vancouver'), camp('c1', 'Camas'),
  ])),
  [['Beaverton', ['b1']], ['Camas', ['c1']], ['Happy Valley', ['h1']], ['Vancouver', ['m1', 'f1', 'm2']]]);

eq('a camp with no city goes last under its own heading, never under the last city',
  shape(groupCampsByArea([camp('x', null), camp('v', 'Vancouver'), camp('y', '  ')])),
  [['Vancouver', ['v']], [NO_AREA_HEADING, ['x', 'y']]]);

eq('no camp has a city: one group, no heading (page looks as before)',
  shape(groupCampsByArea([camp('a', null), camp('b', '')])),
  [[null, ['a', 'b']]]);

eq('one city still gets its heading', shape(groupCampsByArea([camp('a', 'Camas')])), [['Camas', ['a']]]);
eq('empty list: no groups', groupCampsByArea([]), []);
eq('null list: no groups', groupCampsByArea(null), []);
eq('a camp with no location row at all is not lost',
  shape(groupCampsByArea([{ id: 'z' }, camp('v', 'Vancouver')])),
  [['Vancouver', ['v']], [NO_AREA_HEADING, ['z']]]);
eq('keys are unique and stable',
  groupCampsByArea([camp('a', 'Camas'), camp('b', null)]).map((g) => g.key),
  ['area:Camas', 'area:none']);

// --- where line ---------------------------------------------------------------
eq('venue and address',
  campWhereLabel(camp('m', 'Vancouver', 'Marshall Community Center', '1009 E McLoughlin Blvd, Vancouver, WA 98663')),
  'Marshall Community Center, 1009 E McLoughlin Blvd, Vancouver, WA 98663');
eq('venue only', campWhereLabel(camp('m', 'Vancouver', 'Marshall Community Center', null)), 'Marshall Community Center');
eq('address only', campWhereLabel(camp('m', null, '', '1 Main St')), '1 Main St');
eq('nothing set: null, so no empty line renders', campWhereLabel({ id: 'q' }), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
