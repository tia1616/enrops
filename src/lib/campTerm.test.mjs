// Pins campTermForDate: the season a camp is filed under, from its first day.
// Repo convention: plain node script with a pass/fail counter, run by
// scripts/run-src-tests.mjs.
//
// programs.term is NOT NULL, so every camp gets one. This decides it WITHOUT
// asking, because the dates already answer the question - Jessica, 2026-09-28:
// "why does it still ask which term? aren't dates enough? and summer won't have
// a term."
import { campTermForDate, firstMeetingDayOnOrAfter } from './programSchedule.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  if (actual === expected) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n  expected: ${expected}\n  actual:   ${actual}`); }
}

// --- the case that drove the whole design -----------------------------------
// December is inside the FALL after-school term (J2S's FA26 runs sessions into
// January), but a 21 December camp is a WINTER BREAK camp. Filing it under Fall
// would keep it off the winter schedule Jessica asked for it to be on.
eq('winter break camp -> Winter of the FOLLOWING year', campTermForDate('2026-12-21'), 'WI27');
eq('...and its January half is the same term', campTermForDate('2027-01-04'), 'WI27');
eq('Presidents week is still Winter', campTermForDate('2027-02-15'), 'WI27');

// --- the other camp seasons -------------------------------------------------
// Late March is spring break, which is why the seasons are colloquial rather
// than the school-term boundaries (WI27's after-school runs to 2027-03-15).
eq('spring break camp -> Spring', campTermForDate('2027-03-29'), 'SP27');
eq('April is Spring', campTermForDate('2027-04-06'), 'SP27');
// Summer is the case Jessica raised: she runs no summer after-school term, so a
// picker built from her terms had nothing right to offer. org_terms() grows the
// list from the programs themselves, so this makes "Summer 2027" exist.
eq('June is Summer', campTermForDate('2027-06-21'), 'SU27');
eq('July is Summer', campTermForDate('2027-07-12'), 'SU27');
eq('August is Summer', campTermForDate('2027-08-03'), 'SU27');

// --- autumn, including the no-school days that are NOT winter ---------------
eq('September is Fall', campTermForDate('2026-09-08'), 'FA26');
eq('Thanksgiving camp is Fall, not Winter', campTermForDate('2026-11-26'), 'FA26');
eq('November 30 is still Fall', campTermForDate('2026-11-30'), 'FA26');
// The boundary that flips the year. Dec 1 belongs to the winter that follows it.
eq('December 1 flips to next Winter', campTermForDate('2026-12-01'), 'WI27');

// --- century wrap, so the two-digit year cannot go negative ------------------
eq('December 2099 wraps to WI00', campTermForDate('2099-12-20'), 'WI00');

// --- junk in, null out (the caller falls back rather than writing a bad term) -
eq('no date', campTermForDate(''), null);
eq('null', campTermForDate(null), null);
eq('undefined', campTermForDate(undefined), null);
eq('not a date', campTermForDate('someday'), null);
eq('month 13 rejected', campTermForDate('2026-13-01'), null);
eq('day 00 rejected', campTermForDate('2026-12-00'), null);
eq('a timestamp is not a date string', campTermForDate('2026-12-21T09:00:00Z'), null);

// --- firstMeetingDayOnOrAfter: the day the camp actually STARTS --------------
// An operator can legitimately type "the week of the 30th" and untick Monday.
// The season has to come from the day it MEETS, because that is also what gets
// saved as first_session_date. Deriving from the typed Monday filed a camp
// running entirely in December under Fall - silently, with no dropdown left to
// correct it, so she would open the winter board to staff it and not find it.
const MON_TO_FRI = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
eq('typed day IS a meeting day -> itself',
  firstMeetingDayOnOrAfter('2026-12-21', MON_TO_FRI), '2026-12-21');
eq('typed Monday, camp runs Tue-Fri -> the Tuesday',
  firstMeetingDayOnOrAfter('2026-11-30', ['tuesday', 'wednesday', 'thursday', 'friday']), '2026-12-01');
eq('...and THAT is what decides the season',
  campTermForDate(firstMeetingDayOnOrAfter('2026-11-30', ['tuesday', 'wednesday', 'thursday', 'friday'])), 'WI27');
eq('the typed day alone would have said Fall - the bug',
  campTermForDate('2026-11-30'), 'FA26');
eq('a weekend start rolls to Monday',
  firstMeetingDayOnOrAfter('2026-12-19', MON_TO_FRI), '2026-12-21');
eq('a Saturday-only camp finds its Saturday',
  firstMeetingDayOnOrAfter('2026-12-21', ['saturday']), '2026-12-26');
eq('mixed case and padding still match',
  firstMeetingDayOnOrAfter('2026-12-19', [' Monday ']), '2026-12-21');
eq('no days -> null', firstMeetingDayOnOrAfter('2026-12-21', []), null);
eq('no date -> null', firstMeetingDayOnOrAfter('', MON_TO_FRI), null);
eq('junk date -> null', firstMeetingDayOnOrAfter('someday', MON_TO_FRI), null);
eq('unrecognised day names -> null, never a wrong date',
  firstMeetingDayOnOrAfter('2026-12-21', ['funday']), null);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
