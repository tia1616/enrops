// Regression tests for the one canonical "when does a class run" formatter.
// Pure — inline fixtures, no deps. Run: `node src/lib/programSchedule.test.mjs`
//
// A fixed `now` (2026-08-04) is passed everywhere so the year-when-different
// suffix is deterministic and this file never depends on the wall clock.
import {
  formatStartDate,
  programScheduleSummary,
  formatDayLabel,
  campDayCoverage,
} from './programSchedule.js';

const NOW = new Date('2026-08-04T12:00:00');
let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
}

// --- formatStartDate ---
// Local-midnight parse: 2026-09-15 must read Sep 15, NOT Sep 14 (the UTC-parse
// bug that shifts a day west of Greenwich — every family this platform serves).
eq('startDate: TZ safe (Sep 15 not 14)', formatStartDate('2026-09-15', NOW), 'Sep 15');
eq('startDate: year shown when different', formatStartDate('2027-01-05', NOW), 'Jan 5, 2027');
eq('startDate: no year when same', formatStartDate('2026-12-31', NOW), 'Dec 31');
eq('startDate: null in', formatStartDate(null, NOW), null);
eq('startDate: empty string', formatStartDate('', NOW), null);
eq('startDate: malformed', formatStartDate('not-a-date', NOW), null);

// --- programScheduleSummary ---
eq('summary: typical 8-session', programScheduleSummary({ first_session_date: '2026-09-15', session_count: 8 }, NOW), 'Starts Sep 15 · 8 sessions');
eq('summary: J2S FA26 real row', programScheduleSummary({ first_session_date: '2026-09-04', session_count: 8 }, NOW), 'Starts Sep 4 · 8 sessions');
eq('summary: one-off workshop', programScheduleSummary({ first_session_date: '2026-08-15', session_count: 1 }, NOW), 'Meets Aug 15');
eq('summary: one-off, no date', programScheduleSummary({ first_session_date: null, session_count: 1 }, NOW), null);
eq('summary: start only, no count', programScheduleSummary({ first_session_date: '2026-09-15', session_count: null }, NOW), 'Starts Sep 15');
eq('summary: count only, no start', programScheduleSummary({ first_session_date: null, session_count: 8 }, NOW), '8 sessions');
eq('summary: neither', programScheduleSummary({ first_session_date: null, session_count: null }, NOW), null);
eq('summary: zero sessions -> no "0 sessions"', programScheduleSummary({ first_session_date: '2026-09-15', session_count: 0 }, NOW), 'Starts Sep 15');
eq('summary: garbage count dropped', programScheduleSummary({ first_session_date: '2026-09-15', session_count: 'abc' }, NOW), 'Starts Sep 15');
eq('summary: string count coerced', programScheduleSummary({ first_session_date: '2026-09-15', session_count: '11' }, NOW), 'Starts Sep 15 · 11 sessions');
eq('summary: malformed date, count kept', programScheduleSummary({ first_session_date: 'not-a-date', session_count: 8 }, NOW), '8 sessions');
eq('summary: undefined program', programScheduleSummary(undefined, NOW), null);

// --- formatDayLabel (must agree with the summary's one-session coercion) ---
eq('day: normal -> plural', formatDayLabel({ day_of_week: 'Monday', session_count: 8 }), 'Mondays');
eq('day: one session -> singular', formatDayLabel({ day_of_week: 'Monday', session_count: 1 }), 'Monday');
eq('day: string "1" -> singular (same coercion as summary)', formatDayLabel({ day_of_week: 'Monday', session_count: '1' }), 'Monday');
eq('day: null count -> plural', formatDayLabel({ day_of_week: 'Monday', session_count: null }), 'Mondays');
eq('day: no day -> null (never "nulls")', formatDayLabel({ day_of_week: null, session_count: 8 }), null);
eq('day: undefined program', formatDayLabel(undefined), null);

// --- formatDayLabel, CAMPS (class_days set) ---
// A camp's day_of_week is NOT NULL and holds its FIRST day, so class_days has to
// win. Without that a Mon-Fri camp advertised itself as "Mondays" on the public
// catalog card, above its Register button - a parent reads a weekly Monday class
// and buys a week of full-day camp.
eq('camp: contiguous run -> range',
  formatDayLabel({ day_of_week: 'Monday', session_count: 10, class_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] }), 'Mon-Fri');
eq('camp: out-of-order input still reads in calendar order',
  formatDayLabel({ day_of_week: 'Wednesday', session_count: 3, class_days: ['friday', 'wednesday', 'thursday'] }), 'Wed-Fri');
// A holiday week is the case the camp form was built for: a gap must NOT be
// flattened into a range, or the card promises a day the camp does not meet.
eq('camp: gap -> list, never a range that lies',
  formatDayLabel({ day_of_week: 'Monday', session_count: 3, class_days: ['monday', 'tuesday', 'thursday'] }), 'Mon, Tue, Thu');
eq('camp: single day -> that day, not a range',
  formatDayLabel({ day_of_week: 'Monday', session_count: 1, class_days: ['monday'] }), 'Mon');
// Empty / unrecognised class_days must fall back to the weekly label rather than
// returning '' , which the card would render as a stray separator dot.
eq('camp: empty class_days falls back to the weekly label',
  formatDayLabel({ day_of_week: 'Monday', session_count: 8, class_days: [] }), 'Mondays');
eq('camp: junk class_days falls back to the weekly label',
  formatDayLabel({ day_of_week: 'Monday', session_count: 8, class_days: ['funday'] }), 'Mondays');


// --- campDayCoverage ---
// Jessica, 2026-10-01, on Presidents Week LEGO Camp: "dates don't match days
// and still saved". class_days said mon-thu; the window ended Wednesday, so the
// camp ran three days while every label advertised four.
eq('coverage: a chosen day the dates never reach',
  campDayCoverage(['monday', 'tuesday', 'wednesday', 'thursday'], ['2027-02-15', '2027-02-16', '2027-02-17']),
  { meets: ['monday', 'tuesday', 'wednesday'], never: ['thursday'] });
eq('coverage: every chosen day occurs -> nothing to refuse',
  campDayCoverage(['monday', 'tuesday', 'wednesday', 'thursday'], ['2027-02-15', '2027-02-16', '2027-02-17', '2027-02-18']).never,
  []);
// A day lost to the site's own closure_dates is never met either: the camp does
// not run it, so the label must not name it.
eq('coverage: a day lost to a closure counts as never met',
  campDayCoverage(['monday', 'tuesday', 'wednesday'], ['2027-02-15', '2027-02-17']).never,
  ['tuesday']);
// Bare 'YYYY-MM-DD' parses as UTC and lands on the previous day west of
// Greenwich; if that regressed every weekday below shifts by one.
eq('coverage: TZ safe (Feb 15 2027 is a Monday)',
  campDayCoverage(['monday'], ['2027-02-15']).meets, ['monday']);
// Unusable input must NOT look like a violation - the caller skips the check
// rather than refusing a save on a shape it cannot read.
eq('coverage: null in -> empty, not a refusal', campDayCoverage(null, null), { meets: [], never: [] });
eq('coverage: non-array dates -> no false "never"', campDayCoverage(['monday'], 'nope').never, []);
eq('coverage: junk day names are not reported missing', campDayCoverage(['funday'], ['2027-02-15']).never, []);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
