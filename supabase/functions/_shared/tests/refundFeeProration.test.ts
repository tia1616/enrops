import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  campSessionDates,
  sessionsRemainingFraction,
  todayInTimezone,
} from '../refundFeeProration.ts';

// The canonical 8-session weekly program, Tuesdays from 2026-08-10.
// These are the real dates derive_program_session_dates() returns for the
// staging Direct Charge Test Class.
const EIGHT = [
  '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31',
  '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28',
];

// ── v4 section 2's three stated endpoints ─────────────────────────────────

Deno.test('v4: before the program starts -> 100% of the fee refunded', () => {
  assertEquals(sessionsRemainingFraction(EIGHT, '2026-07-27'), 1);
  // The day of the first session still counts as nothing delivered.
  assertEquals(sessionsRemainingFraction(EIGHT, '2026-08-10'), 1);
});

Deno.test('v4: after the program ends -> 0% of the fee refunded', () => {
  assertEquals(sessionsRemainingFraction(EIGHT, '2026-09-29'), 0);
  assertEquals(sessionsRemainingFraction(EIGHT, '2027-01-01'), 0);
});

Deno.test('v4: mid-program -> straight line by sessions remaining', () => {
  // Day after session 4 of 8: four left.
  assertEquals(sessionsRemainingFraction(EIGHT, '2026-09-01'), 0.5);
  // Day after session 1: seven left.
  assertEquals(sessionsRemainingFraction(EIGHT, '2026-08-11'), 7 / 8);
  // The last session's own day: one left, not zero.
  assertEquals(sessionsRemainingFraction(EIGHT, '2026-09-28'), 1 / 8);
});

// ── the fail-generous rule ────────────────────────────────────────────────

// POLICY, LOCKED. An unknown schedule must never let Enrops KEEP a fee it
// cannot justify. If someone "fixes" this to 0, every registration with a
// missing calendar silently stops refunding our fee and nobody finds out.
Deno.test('POLICY: no session dates -> full fee refund, never zero', () => {
  assertEquals(sessionsRemainingFraction([], '2026-09-01'), 1);
});

Deno.test('unsorted and malformed dates do not change the answer', () => {
  const scrambled = ['2026-09-28', '', '2026-08-10', '2026-09-07', 'x'];
  // Three usable dates; on 2026-09-08 only 2026-09-28 is left.
  assertEquals(sessionsRemainingFraction(scrambled, '2026-09-08'), 1 / 3);
});

// ── camps ─────────────────────────────────────────────────────────────────

Deno.test('camp week expands to its class days only', () => {
  // A real staging camp: Mon+Wed only, 2026-07-06 to 2026-07-08.
  assertEquals(
    campSessionDates('2026-07-06', '2026-07-08', ['monday', 'wednesday']),
    ['2026-07-06', '2026-07-08'],
  );
});

Deno.test('camp Mon-Fri week is five sessions, and prorates like a program', () => {
  const week = campSessionDates('2026-07-27', '2026-07-31', [
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  ]);
  assertEquals(week.length, 5);
  assertEquals(sessionsRemainingFraction(week, '2026-07-27'), 1);
  assertEquals(sessionsRemainingFraction(week, '2026-07-29'), 3 / 5);
  assertEquals(sessionsRemainingFraction(week, '2026-08-01'), 0);
});

Deno.test('camp with no class_days counts every day in the range', () => {
  assertEquals(campSessionDates('2026-07-27', '2026-07-29', null).length, 3);
});

Deno.test('camp with a single day, or a bad range, never throws', () => {
  assertEquals(campSessionDates('2026-07-27', null, null), ['2026-07-27']);
  assertEquals(campSessionDates('2026-07-27', '2026-07-01', null), []);
  assertEquals(campSessionDates(null, '2026-07-01', null), []);
});

// ── the local-date rule ───────────────────────────────────────────────────

// A refund at 5pm Pacific is still "today" locally but already tomorrow in UTC.
// Getting this wrong counts one more session as delivered and under-refunds the
// operator on exactly the boundary day.
Deno.test('the as-of date is local, not UTC', () => {
  const evening = new Date('2026-09-08T01:30:00Z'); // 6:30pm Sept 7 Pacific
  assertEquals(todayInTimezone('America/Los_Angeles', evening), '2026-09-07');
  assertEquals(todayInTimezone(null, evening), '2026-09-07'); // platform default
  assertEquals(todayInTimezone('America/New_York', evening), '2026-09-07');
});

Deno.test('an unknown timezone falls back to UTC instead of throwing', () => {
  const t = new Date('2026-09-08T01:30:00Z');
  assertEquals(todayInTimezone('Not/AZone', t), '2026-09-08');
});
