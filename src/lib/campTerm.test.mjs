// Pins campTermForDate: the season a camp is filed under, from its first day.
// Repo convention: plain node script with a pass/fail counter, run by
// scripts/run-src-tests.mjs.
//
// programs.term is NOT NULL, so every camp gets one. This decides it WITHOUT
// asking, because the dates already answer the question - Jessica, 2026-09-28:
// "why does it still ask which term? aren't dates enough? and summer won't have
// a term."
import { campTermForDate } from './programSchedule.js';

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

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
