// Pins the student-birthdate plausibility rule. Repo convention: plain node
// script with a pass/fail counter, run by scripts/run-src-tests.mjs.
//
// The case that created this file is the first assertion in the "the real defect"
// block: Patrick Moloney's 1980-12-18 passing as a 1st grader on 2026-08-19.
import {
  ageOn, todayIso, birthdateProblem,
  MIN_PLAUSIBLE_AGE, MAX_PLAUSIBLE_AGE,
} from './studentBirthdate.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`); }
}

// --- ageOn: whole years, birthday boundary ---------------------------------

eq('exact birthday counts as the new age', ageOn('2019-08-19', '2026-08-19'), 7);
eq('day before birthday is still the old age', ageOn('2019-08-20', '2026-08-19'), 6);
eq('day after birthday', ageOn('2019-08-18', '2026-08-19'), 7);
eq('earlier month in the year', ageOn('2019-01-05', '2026-08-19'), 7);
eq('later month in the year', ageOn('2019-12-05', '2026-08-19'), 6);
eq('leap-day birthday, non-leap reference', ageOn('2020-02-29', '2026-08-19'), 6);
eq('unparseable birthdate is null', ageOn('not-a-date', '2026-08-19'), null);
eq('unparseable reference is null', ageOn('2019-08-19', ''), null);

// No Date() anywhere in the parse, so a timezone west of UTC cannot shift a day.
eq('a date-only string is not shifted by timezone', ageOn('2019-01-01', '2026-01-01'), 7);

// --- todayIso: local calendar date, zero-padded ----------------------------

eq('todayIso pads month and day', todayIso(new Date(2026, 0, 5, 23, 30)), '2026-01-05');
eq('todayIso uses local date, not UTC', todayIso(new Date(2026, 7, 19, 23, 59)), '2026-08-19');

// --- birthdateProblem: the real defect ------------------------------------

const patrick = birthdateProblem('1980-12-18', '2026-08-19');
eq('a parent\'s own birth date is caught', patrick?.code, 'too_old');
eq('the caught age is named in the message', patrick?.message.includes('45'), true);
eq('the message tells them whose birth date to use', patrick?.message.includes('rather than your own'), true);

// --- birthdateProblem: plausible students pass ----------------------------

for (const [label, dob, expectAge] of [
  ['a 1st grader', '2019-06-01', 7],
  ['a kindergartener', '2021-03-14', 5],
  ['a middle schooler', '2013-11-02', 12],
  ['a high schooler', '2009-09-30', 16],
]) {
  const p = birthdateProblem(dob, '2026-08-19');
  eq(`${label} passes (age ${expectAge})`, p, null);
}

// --- birthdateProblem: the band edges are INCLUSIVE ------------------------
// A guard that argues with a legitimate 4-year-old or an 18-year-old is worse
// than no guard: the parent cannot get past it and abandons a paid checkout.

eq(`exactly MIN (${MIN_PLAUSIBLE_AGE}) is allowed`, birthdateProblem('2023-08-19', '2026-08-19'), null);
eq(`exactly MAX (${MAX_PLAUSIBLE_AGE}) is allowed`, birthdateProblem('2007-08-19', '2026-08-19'), null);
eq('one year under MIN is caught', birthdateProblem('2024-08-19', '2026-08-19')?.code, 'too_young');
eq('one year over MAX is caught', birthdateProblem('2006-08-19', '2026-08-19')?.code, 'too_old');

// --- birthdateProblem: empty is NOT this guard's business -----------------
// Returning a problem for '' would light the field red before the parent types.
// The required-field check in advanceProblem() (src/lib/registerAdvance.js) owns
// the empty case, and says "Add your child's date of birth." for it.

eq('empty string is silent', birthdateProblem('', '2026-08-19'), null);
eq('undefined is silent', birthdateProblem(undefined, '2026-08-19'), null);
eq('null is silent', birthdateProblem(null, '2026-08-19'), null);
eq('whitespace is silent', birthdateProblem('   ', '2026-08-19'), null);

// --- birthdateProblem: malformed and future -------------------------------

eq('garbage is unparseable', birthdateProblem('12/18/1980', '2026-08-19')?.code, 'unparseable');
eq('month 13 is unparseable', birthdateProblem('2019-13-01', '2026-08-19')?.code, 'unparseable');
eq('day 00 is unparseable', birthdateProblem('2019-01-00', '2026-08-19')?.code, 'unparseable');
eq('a future birth date is caught', birthdateProblem('2027-01-01', '2026-08-19')?.code, 'future');
eq('a typo\'d far-future year is caught', birthdateProblem('2196-01-01', '2026-08-19')?.code, 'future');

// A mistyped century reads as "too old", not as a crash.
eq('1919 typo is caught as too_old', birthdateProblem('1919-06-01', '2026-08-19')?.code, 'too_old');

// --- singular/plural in the too_young message ----------------------------

eq('1 year old reads "1 year"', birthdateProblem('2025-08-19', '2026-08-19')?.message.includes('1 year old'), true);
eq('2 years old reads "2 years"', birthdateProblem('2024-08-19', '2026-08-19')?.message.includes('2 years old'), true);

// --- parts(): the day must exist in that month --------------------------------
// Independent bounds (mo 1-12, d 1-31) let 2019-02-30 through, and it failed
// QUIETLY: ageOn's same-month branch compared 28 < 30 and returned 6 for a
// seven-year-old, inside the plausible band, so no message was shown.

eq('Feb 30 is unparseable', birthdateProblem('2019-02-30', '2026-08-19')?.code, 'unparseable');
eq('Feb 29 in a non-leap year is unparseable', birthdateProblem('2019-02-29', '2026-08-19')?.code, 'unparseable');
eq('Feb 29 in a leap year is fine', birthdateProblem('2020-02-29', '2026-08-19'), null);
eq('Feb 29 in 2000 (400-year rule) is fine', ageOn('2000-02-29', '2026-08-19'), 26);
eq('Feb 29 in 1900 (100-year rule) is unparseable', birthdateProblem('1900-02-29', '2026-08-19')?.code, 'unparseable');
eq('April 31 is unparseable', birthdateProblem('2019-04-31', '2026-08-19')?.code, 'unparseable');
eq('June 31 is unparseable', birthdateProblem('2019-06-31', '2026-08-19')?.code, 'unparseable');
eq('September 31 is unparseable', birthdateProblem('2019-09-31', '2026-08-19')?.code, 'unparseable');
eq('November 31 is unparseable', birthdateProblem('2019-11-31', '2026-08-19')?.code, 'unparseable');
eq('January 31 is fine', birthdateProblem('2019-01-31', '2026-08-19'), null);
eq('December 31 is fine', birthdateProblem('2019-12-31', '2026-08-19'), null);
eq('day 32 is unparseable', birthdateProblem('2019-01-32', '2026-08-19')?.code, 'unparseable');
// The wrong answer this replaced: 6, not 7.
eq('the Feb-30 age is no longer computed at all', ageOn('2019-02-30', '2026-02-28'), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
