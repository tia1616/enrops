// Pins the public registration catalog's district -> school picker.
// Repo convention: plain node script with a pass/fail counter, run by
// scripts/run-src-tests.mjs.
//
// This shipped to prod on 2026-08-14 with no test at all. Every case below is
// either a state the picker can actually be in, or a bug that really happened.
import { buildCatalogPicker, buildLocationOptions, groupByDistrict, OTHER_DISTRICT } from './regCatalogPicker.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`); }
}

// --- fixtures --------------------------------------------------------------
// Shaped like Jeff's real prod catalog: several districts at different prices,
// which is the whole reason the gate exists.
const D = { pps: 'd-pps', losd: 'd-losd', ever: 'd-ever' };
const NAMES = { [D.pps]: 'PPS', [D.losd]: 'LOSD', [D.ever]: 'Evergreen Public Schools' };

const prog = (id, locId, locName, districtId, price) => ({
  id, program_location_id: locId, price_cents: price,
  program_locations: { name: locName, district_id: districtId },
});

const JEFF = [
  prog('p1', 'l-oak', 'Oak Creek Elementary', D.losd, 32900),
  prog('p2', 'l-rieke', 'Rieke Elementary', D.pps, 29900),
  prog('p3', 'l-ains', 'Ainsworth Elementary', D.pps, 29900),
  prog('p4', 'l-illa', 'Illahee Elementary', D.ever, 29900),
  prog('p5', 'l-lib', 'Community Library', null, 29900),
];

// --- the gate: nothing on screen until a school is picked ------------------
// This IS the feature. Jeff: "I don't want someone to get scared off by looking
// at a price tag for a program at a more expensive district." His page opened on
// LOSD at $329 when the family's own school was $299.
{
  const v = buildCatalogPicker(JEFF, NAMES, { district: '', school: '' });
  eq('no school picked -> zero classes on screen', v.visiblePrograms.length, 0);
  eq('no school picked -> not chosen', v.schoolChosen, false);
  eq('the expensive district is not on screen either',
    v.visiblePrograms.some((p) => p.price_cents === 32900), false);
}
{
  const v = buildCatalogPicker(JEFF, NAMES, { district: 'PPS', school: 'l-rieke' });
  eq('school picked -> only that school', v.visiblePrograms.map((p) => p.id), ['p2']);
  eq('school picked -> chosen', v.schoolChosen, true);
}

// --- district grouping -----------------------------------------------------
{
  const v = buildCatalogPicker(JEFF, NAMES, {});
  eq('named districts alphabetical, undistricted LAST',
    v.groupNames, ['Evergreen Public Schools', 'LOSD', 'PPS', OTHER_DISTRICT]);
  eq('district step shown with 3 named districts', v.useGroups, true);
  eq('a district-less venue buckets, it does not vanish',
    v.groups.get(OTHER_DISTRICT).map((l) => l.name), ['Community Library']);
}
{
  const v = buildCatalogPicker(JEFF, NAMES, { district: 'PPS', school: '' });
  eq('school choices are scoped to the chosen district',
    v.schoolChoices.map((l) => l.name), ['Ainsworth Elementary', 'Rieke Elementary']);
}

// --- THE BUG THIS WHOLE CHANGE EXISTS FOR ----------------------------------
// Since 20260813d the districts table policy is scoped `to anon`, and access is
// granted by org_members - parents are not org_members. So for every SIGNED-IN
// family the name lookup came back empty. Measured on prod 2026-08-14: j2s 19
// districts signed out, 0 signed in. districts_public fixed the read; this pins
// what the picker does if it ever breaks again.
{
  const v = buildCatalogPicker(JEFF, {}, {});
  eq('no district names -> everything buckets as "other"',
    v.groupNames, [OTHER_DISTRICT]);
  eq('no district names -> district step disappears rather than showing one option',
    v.useGroups, false);
  eq('no district names -> the school select still offers every school',
    v.schoolChoices.length, 5);
  eq('no district names -> the gate still holds', v.schoolChosen, false);
}

// --- how many districts earn a district STEP -------------------------------
{
  const onePps = JEFF.filter((p) => p.program_locations.district_id === D.pps);
  const v = buildCatalogPicker(onePps, NAMES, {});
  eq('one district is a dropdown with one answer -> no district step', v.useGroups, false);
  eq('...and the school select offers that district\'s schools',
    v.schoolChoices.map((l) => l.name), ['Ainsworth Elementary', 'Rieke Elementary']);
  eq('...and the gate still holds', v.schoolChosen, false);
}
{
  const two = JEFF.filter((p) => ['l-oak', 'l-rieke'].includes(p.program_location_id));
  eq('two named districts earns the step', buildCatalogPicker(two, NAMES, {}).useGroups, true);
}

// --- a single-site provider is gate-free -----------------------------------
// Asking someone to choose between one thing is theatre.
{
  const one = [prog('p1', 'l-only', 'The Studio', null, 12000)];
  const v = buildCatalogPicker(one, NAMES, {});
  eq('one location -> no picker', v.hasMultiLoc, false);
  eq('one location -> classes show immediately', v.visiblePrograms.map((p) => p.id), ['p1']);
  eq('one location -> counts as chosen', v.schoolChosen, true);
}
// Two programs at the SAME location is still one location.
{
  const two = [prog('a', 'l-only', 'The Studio', null, 1), prog('b', 'l-only', 'The Studio', null, 2)];
  const v = buildCatalogPicker(two, NAMES, {});
  eq('two classes at one site -> still no picker', v.hasMultiLoc, false);
  eq('two classes at one site -> both show', v.visiblePrograms.length, 2);
}

// --- stale / unknown selection ---------------------------------------------
// The real bug, found by code review after the build: this component does NOT
// remount when the :slug route param changes, so a school id from the PREVIOUS
// provider survived into the next one's catalog, filtered it to zero, and made a
// provider with a full catalog say "No classes at that school right now."
{
  const v = buildCatalogPicker(JEFF, NAMES, { district: 'PPS', school: 'l-from-another-org' });
  eq('a school id this catalog does not have is treated as unpicked', v.school, '');
  eq('...so the family gets the picker, not a false empty state', v.schoolChosen, false);
  eq('...and no bogus zero-length class list', v.visiblePrograms.length, 0);
}
{
  const v = buildCatalogPicker(JEFF, NAMES, { district: 'Some Other District', school: '' });
  eq('a district this catalog does not have is treated as unpicked', v.district, '');
  eq('...so the school select has nothing to offer yet', v.schoolChoices.length, 0);
}

// --- two locations with the SAME NAME --------------------------------------
// Keying on name collapsed these into one option that showed BOTH locations'
// classes. None exist on prod today; staging riverbend has a pair, and J2S has
// 63 locations, so it was going to happen.
{
  const dupes = [
    prog('p1', 'l-a', 'Ainsworth Elementary', D.pps, 29900),
    prog('p2', 'l-b', 'Ainsworth Elementary', null, 29900),
  ];
  const v = buildCatalogPicker(dupes, NAMES, {});
  eq('same-named locations stay two options', v.locOptions.length, 2);
  eq('...in different district buckets', v.groupNames, ['PPS', OTHER_DISTRICT]);
  const picked = buildCatalogPicker(dupes, NAMES, { district: 'PPS', school: 'l-a' });
  eq('...and picking one shows only ITS class', picked.visiblePrograms.map((p) => p.id), ['p1']);
}

// --- malformed rows do not crash or half-render ----------------------------
{
  const messy = [
    prog('good', 'l-1', 'Real School', D.pps, 1),
    { id: 'noloc', program_location_id: null, program_locations: null },
    { id: 'noname', program_location_id: 'l-2', program_locations: { name: null, district_id: D.pps } },
  ];
  const v = buildCatalogPicker(messy, NAMES, {});
  eq('a program with no usable location is not offered as a school',
    v.locOptions.map((l) => l.id), ['l-1']);
  eq('...and one usable location means no picker at all', v.hasMultiLoc, false);
}
eq('empty catalog is not an error', buildCatalogPicker([], NAMES, {}).locOptions, []);
eq('null catalog is not an error', buildCatalogPicker(null, null, {}).visiblePrograms, []);

// --- helpers used directly by the page -------------------------------------
{
  const locs = buildLocationOptions(JEFF, NAMES);
  eq('one option per distinct location', locs.length, 5);
  eq('district name is resolved from the id map',
    locs.find((l) => l.id === 'l-oak').district, 'LOSD');
  eq('a location with no district id gets the bucket',
    locs.find((l) => l.id === 'l-lib').district, OTHER_DISTRICT);
  eq('a district id with no NAME in the map also gets the bucket',
    buildLocationOptions([prog('x', 'l-x', 'X', 'd-unknown', 1)], NAMES)[0].district, OTHER_DISTRICT);
}
{
  const { groupNames, namedCount } = groupByDistrict(buildLocationOptions(JEFF, NAMES));
  eq('namedCount excludes the catch-all bucket', namedCount, 3);
  eq('the catch-all sorts last even though "O" < "P"',
    groupNames[groupNames.length - 1], OTHER_DISTRICT);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
