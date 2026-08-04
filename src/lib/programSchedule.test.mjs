// Regression tests for the one canonical "when does a class run" formatter.
// Pure — inline fixtures, no deps. Run: `node src/lib/programSchedule.test.mjs`
//
// A fixed `now` (2026-08-04) is passed everywhere so the year-when-different
// suffix is deterministic and this file never depends on the wall clock.
import {
  formatStartDate,
  programScheduleSummary,
  formatDayLabel,
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
