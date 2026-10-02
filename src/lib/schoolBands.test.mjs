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

import { classifyBands, isSecondaryOnly, secondaryOnlyDates, unansweredSecondaryOnlyDates } from './schoolBands.js';

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
  // Briefly lost when "no" was a blanket negation word, and recovered when
  // that was restricted to the plural "... schools" form. Kept as a REAL
  // expectation rather than a documented miss: "no US classes" means upper
  // school is the band that is out, which is exactly what should be suggested.
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

// --- BLOCKERS found in review 2026-10-02. Each one deleted a REAL closure. ---

// 1. Any two numbers joined by a dash read as a grade range, and anything from
//    6 up counted as secondary. "Winter Break 22-31" was pre-ticked for
//    deletion: one click would have wiped a whole winter break, scheduled five
//    sessions into a shut school and pulled every class's last day five weeks
//    earlier. A grade range now needs the word grade/gr, or to start at K.
for (const label of [
  'Winter Break 22-31', 'Thanksgiving Break 26-28', 'No School 11-27',
  'Conferences (No School) 6-8 pm', 'No School (teacher PD) 8-3', 'Conference Day 12-4',
  'Winter Break Dec 21-31', 'Spring Break 3/22-3/26',
]) {
  ok(`date/time range is not a grade range: ${label}`, isSecondaryOnly(label) === false);
}
ok('an explicit grade range still counts', isSecondaryOnly('Grades 6-8 testing') === true);
ok('gr. 6-8 counts too', isSecondaryOnly('No School gr. 6-8') === true);
ok('a negated grade range is kept', isSecondaryOnly('Early Release except grades 9-12') === false);

// 2. Bare secondary words matched ordinary English. "High Holy Days" is a
//    standard all-school closure; deleting it sends an instructor to a locked
//    building. Secondary words are multi-word only now.
for (const label of [
  'No School: High Holy Days', 'High Holidays - No School', 'Junior Achievement Day - No School',
  'Senior Project Day - No School', 'Middle of Winter Break', 'Upper Field closed',
]) {
  ok(`ordinary English is not a band: ${label}`, isSecondaryOnly(label) === false);
}
ok('"high school" still counts', isSecondaryOnly('No School - High School Finals') === true);
ok('"middle school" still counts', isSecondaryOnly('Middle School Conferences') === true);

// 3. "US" is Upper School in a school calendar and the COUNTRY everywhere
//    else, and both are capitalised. It counts only before a school word.
ok('US Holiday is the country, kept', isSecondaryOnly('No School - Veterans Day (US Holiday)') === false);
ok('US Thanksgiving Holiday is the country, kept', isSecondaryOnly('US Thanksgiving Holiday') === false);
ok('US Conferences is Upper School, dropped', isSecondaryOnly('US Conferences - no US classes') === true);

// 4. The negation guard covered two spellings and nothing adjacent. Every word
//    added can only move an answer towards KEEP, so this list is liberal.
for (const label of [
  'Early Release (excl. HS)', 'Early Release - no high schools',
  'Early Release Day - all schools but high schools', 'Early Release Day, high schools excepted',
  'Early Release, high schools exempt', 'Early release excluding high school',
]) {
  ok(`negation spelling handled: ${label}`, isSecondaryOnly(label) === false);
}

// 5. An infinite loop, hit the moment "no" became a negator: lastIndexOf(x, -1)
//    searches from 0 and returns 0 forever. Any label whose window starts with
//    a negator used to hang the browser tab.
ok('a negator at index 0 terminates', (() => {
  const t0 = Date.now();
  isSecondaryOnly('No School 11-27');
  isSecondaryOnly('not');
  isSecondaryOnly('no no no no high school');
  return Date.now() - t0 < 1000;
})());

// --- unansweredSecondaryOnlyDates: the one function the row badge and the
// panel must agree on, and it had no coverage at all. ---
const mixed = [
  { date: '2026-11-06', reason: 'No School: HS Grade Prep' },
  { date: '2026-12-11', reason: 'No School: MS Grade Prep', applies: true },
  { date: '2027-03-19', reason: 'No School: MS Grade Prep', applies: false },
  { date: '2026-11-26', reason: 'Holiday: Thanksgiving' },
  { date: '2026-10-29', reason: 'No School: Elem, MS Conferences', applies: true },
];
const un = unansweredSecondaryOnlyDates(mixed);
ok('a date already answered is not re-asked', !un.some((r) => r.date === '2026-12-11'));
ok('applies:false is still asked', un.some((r) => r.date === '2027-03-19'));
ok('an unanswered secondary date is asked', un.some((r) => r.date === '2026-11-06'));
ok('a non-secondary date is never asked', !un.some((r) => r.date === '2026-11-26'));
ok('answering one date does not suppress another', un.length === 2);
ok('non-array input is safe', unansweredSecondaryOnlyDates(null).length === 0);

// --- BLOCKERS the FIX ROUND itself introduced, 2026-10-02. ---
// Making "no" a negation word inverted the safety property: it stripped the
// ELEMENTARY band off a label and left it reading secondary-only, so a day
// elementary is actually shut came back pre-ticked for deletion.
for (const label of [
  'No Elementary Classes, MS Conferences',
  'No Preschool - HS Exams',
  'No Kindergarten; MS Conferences',
  'No K-5 Classes; MS Conferences',
  'No LS Classes, US Exams',
  'No PK Classes - HS Finals',
  'No pre-k, MS/HS conferences',
]) {
  ok(`"no <elementary>" must NOT strip the keep-guard: ${label}`, isSecondaryOnly(label) === false);
}
// ...and it killed the feature's main case, because "No MS Classes" negated
// its own MS. Both directions came from the same token.
for (const label of ['No MS Classes', 'No HS Classes', 'No Middle School Classes', 'No High School Finals']) {
  ok(`"no <secondary>" still flags: ${label}`, isSecondaryOnly(label) === true);
}
// "no" survives only for the plural "... schools" exclusion, which is the real
// PPS wording it was added for.
ok('"no high schools" is still an exclusion', isSecondaryOnly('Early Release - no high schools') === false);
ok('"No School: MS Grade Prep" does not self-negate', isSecondaryOnly('No School: MS Grade Prep') === true);

// The trim fix had been applied in confirm() but not here, so an answered row
// whose stored date had whitespace was re-asked forever.
ok('an answered date with stored whitespace is not re-asked',
  unansweredSecondaryOnlyDates([
    { date: ' 2026-11-06', reason: 'No School: HS Grade Prep', applies: true },
    { date: '2026-12-11 ', reason: 'No School: MS Grade Prep', applies: true },
  ]).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
