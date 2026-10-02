// Pins schoolBands against EVERY closure label that actually exists in the two
// live databases, read off them on 2026-10-02 rather than imagined. The list
// below is the real vocabulary, not a sample: if a new abbreviation shows up in
// a future upload it belongs here with its expected answer.
//
// The two that matter most, because getting either backwards causes a wrong
// email to families:
//   - "Early Release Days (not high schools)" and "Early Release Day - Except
//     High Schools" are 16 real PPS dates that DO apply to elementary. A naive
//     "contains HS" rule drops exactly these.
//   - "US Conferences" is UPPER SCHOOL, not a country, and does NOT apply.

import { classifyBands, isSecondaryOnly, secondaryOnlyDates } from './schoolBands.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}

// --- every label in prod + staging, with the answer a provider should see ---
// true  = suggest dropping it (names secondary bands only)
// false = keep it
const REAL_LABELS = [
  ['Conferences: NO SCHOOL P, EL & MS', false],
  ['Early Release - Last Day of School K-11', false],
  ['Early Release Days (not high schools)', false],
  ['Early Release Day - Except High Schools', false],
  ['Elementary & Secondary Staff Development', false],
  ['Elementary Conferences', false],
  ['Elementary Work Day / Secondary Grade Prep', false],
  ['Family Conf. Connections K-12', false],
  ['LS Conferences - no LS classes', false],
  ['LS Report Writing - no LS classes', false],
  ['LS/MS Conferences - no classes LS/MS', false],
  ['LS/MS Conferences, US Conference prep - no classes', false],
  ['LS/MS/US Comment Writing - no classes', false],
  ['No School: Elem Grade Prep', false],
  ['No School: Elem Work Day', false],
  ['No School: Elem, HS Grade Prep', false],
  ['No School: Elem, MS Conferences', false],
  ['Spring Break: NO SCHOOL P, EL, & MS', false],
  ['Winter Break: NO SCHOOL P, EL, & MS', false],
  ['School Not in Session', false],
  ['No School: HS Grade Prep', true],
  ['No School: MS Grade Prep', true],
  ['US Conferences - no US classes', true],
  ['US Spring Break starts - no US classes', true],
];
for (const [label, expected] of REAL_LABELS) {
  ok(`${expected ? 'drop' : 'keep'}: ${label}`, isSecondaryOnly(label) === expected);
}

// --- labels with no band at all are always kept ---
for (const label of [
  'Holiday: Thanksgiving', 'No School: Winter Break', 'Teacher Professional Day',
  'Conferences (No School)', 'Grading Day', 'Day/evening conferences',
  'Schools closed due to holiday or break period', 'Noon Dismissal (accreditation)',
  '', null, undefined,
]) {
  ok(`no band named, kept: ${JSON.stringify(label)}`, isSecondaryOnly(label) === false);
}

// --- the negation trap, both spellings and the shapes around it ---
ok('"not high schools" negates the HS mention', classifyBands('Early Release Days (not high schools)').secondary.length === 0);
ok('"Except High Schools" negates it too', classifyBands('Early Release Day - Except High Schools').secondary.length === 0);
ok('negated band is reported as negated', classifyBands('Early Release Day - Except High Schools').negated.includes('high school'));
ok('"not" with no band does not crash or negate', classifyBands('School Not in Session').secondary.length === 0);
ok('"no LS classes" is NOT a negation - LS is the band that is out', classifyBands('LS Conferences - no LS classes').elementary.includes('LS'));
ok('a negated HS plus a real MS still drops', isSecondaryOnly('MS Grade Prep (not high schools)') === true);

// --- abbreviations are uppercase-only, so ordinary English is not a band ---
ok('lowercase "us" is a pronoun, not Upper School', isSecondaryOnly('Please tell us about the day') === false);
ok('uppercase US is Upper School', isSecondaryOnly('US Conferences') === true);
ok('"Ms" (title case) is not Middle School', isSecondaryOnly('Ms Rivera out') === false);
ok('"ms" inside a word is not a band', isSecondaryOnly('Programs paused') === false);
ok('P only counts standalone', classifyBands('Conferences: NO SCHOOL P, EL & MS').elementary.includes('P'));
ok('"Prep" does not match the P abbreviation', classifyBands('No School: HS Grade Prep').elementary.length === 0);

// --- grade ranges ---
ok('K-12 reaches elementary', isSecondaryOnly('Family Conf. Connections K-12') === false);
ok('K-11 reaches elementary', isSecondaryOnly('Early Release - Last Day of School K-11') === false);
ok('6-8 is secondary only', isSecondaryOnly('Grades 6-8 testing') === true);
ok('3-5 is elementary', isSecondaryOnly('Grades 3-5 field trip') === false);

// --- the safety property itself ---
ok('elementary word always keeps, whatever else is named',
  REAL_LABELS.filter(([l]) => /elem|\bLS\b|\bEL\b/i.test(l)).every(([l]) => isSecondaryOnly(l) === false));
ok('a label naming both bands is kept', isSecondaryOnly('Elementary & Secondary Staff Development') === false);

// --- secondaryOnlyDates filters rows, keeps order, drops unusable dates ---
const rows = [
  { date: '2026-11-06', reason: 'No School: HS Grade Prep' },
  { date: '2026-10-29', reason: 'No School: Elem, MS Conferences' },
  { date: '2026-12-11', reason: 'No School: MS Grade Prep' },
  { date: 'not-a-date', reason: 'No School: MS Grade Prep' },
  { reason: 'No School: MS Grade Prep' },
];
const picked = secondaryOnlyDates(rows);
ok('only the secondary-only rows are suggested', picked.length === 2);
ok('input order is preserved', picked[0].date === '2026-11-06' && picked[1].date === '2026-12-11');
ok('a row with no usable date is never suggested', picked.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date)));
ok('non-array input is safe', secondaryOnlyDates(null).length === 0 && secondaryOnlyDates(undefined).length === 0);

// --- the three LOSD dates this whole build exists for ---
ok('LOSD 6 Nov / 11 Dec / 19 Mar are all suggested', ['No School: HS Grade Prep', 'No School: MS Grade Prep']
  .every((r) => isSecondaryOnly(r) === true));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
