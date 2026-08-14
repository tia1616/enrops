// Pins the per-date times in a calendar invite.
//
// THE BUG THIS EXISTS FOR: derive_program_session_dates used to skip occasional
// early-release days entirely, so "one start time for the whole series" was true
// by construction and calendarInvite.ts relied on it. Once a class can KEEP those
// dates and meet earlier, that assumption silently produces an invite that fires
// a parent's reminder at the usual time on precisely the day pickup moved.
//
// Found by self-review (gate C2), not by a failing build -- nothing here throws.

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  buildIcs,
  googleCalendarUrl,
  timesForDate,
  uniformTimes,
  calendarEventsFromRegistrations,
  type CalendarEvent,
} from '../calendarInvite.ts';

const BASE: CalendarEvent = {
  programName: 'Minecraft Coders',
  orgName: 'Test Provider',
  sessionDates: ['2026-09-02', '2026-09-09', '2026-09-16'],
  startTime: '2:35 PM',
  endTime: '3:35 PM',
};

const WITH_ER: CalendarEvent = {
  ...BASE,
  sessionTimes: { '2026-09-16': { start: '1:20 PM', end: '2:20 PM' } },
};

Deno.test('a date with no override keeps the class time', () => {
  const { start, end } = timesForDate(WITH_ER, '2026-09-02');
  assertEquals(start, { h: 14, m: 35 });
  assertEquals(end, { h: 15, m: 35 });
});

Deno.test('an overridden date uses its OWN time', () => {
  const { start, end } = timesForDate(WITH_ER, '2026-09-16');
  assertEquals(start, { h: 13, m: 20 });
  assertEquals(end, { h: 14, m: 20 });
});

Deno.test('an override with no end does NOT borrow the class end time', () => {
  // Borrowing 3:35 PM would run the class an hour past the early dismissal --
  // worse than the +1h default the ICS builder applies from the earlier start.
  const ev: CalendarEvent = { ...BASE, sessionTimes: { '2026-09-16': { start: '1:20 PM' } } };
  const { start, end } = timesForDate(ev, '2026-09-16');
  assertEquals(start, { h: 13, m: 20 });
  assertEquals(end, null);
});

Deno.test('the .ics puts the early-release session at its earlier time', () => {
  const ics = buildIcs([WITH_ER], { uidSeed: 'seed', nowIso: '2026-08-14T10:00:00.000Z' });
  // Two ordinary sessions at 14:35, one early-release at 13:20.
  assertEquals((ics.match(/DTSTART:20260902T143500/g) || []).length, 1);
  assertEquals((ics.match(/DTSTART:20260909T143500/g) || []).length, 1);
  assertEquals((ics.match(/DTSTART:20260916T132000/g) || []).length, 1);
  assertEquals((ics.match(/DTEND:20260916T142000/g) || []).length, 1);
  // and the wrong one is nowhere in the file
  assertEquals(ics.includes('DTSTART:20260916T143500'), false);
});

Deno.test('an ordinary series is unchanged by the new field', () => {
  const ics = buildIcs([BASE], { uidSeed: 'seed', nowIso: '2026-08-14T10:00:00.000Z' });
  assertEquals((ics.match(/DTSTART:\d{8}T143500/g) || []).length, 3);
});

Deno.test('mixed times disqualify the weekly recurrence rule', () => {
  // The dates ARE a clean weekly cadence, so the only thing stopping the rule is
  // the differing time -- which is the case this guards.
  assertEquals(uniformTimes(BASE), true);
  assertEquals(uniformTimes(WITH_ER), false);
  const plain = googleCalendarUrl(BASE) ?? '';
  const mixed = googleCalendarUrl(WITH_ER) ?? '';
  assertEquals(plain.includes('recur='), true);
  assertEquals(mixed.includes('recur='), false);
});

Deno.test('the google link uses the first session own time when THAT is the exception', () => {
  const ev: CalendarEvent = { ...BASE, sessionTimes: { '2026-09-02': { start: '1:20 PM', end: '2:20 PM' } } };
  const url = googleCalendarUrl(ev) ?? '';
  assertEquals(url.includes('dates=20260902T132000/20260902T142000'), true);
});

Deno.test('slots that match the class time produce NO override map', async () => {
  const events = await calendarEventsFromRegistrations(
    [{ programs: { id: 'p1', curriculum: 'C', start_time: '2:35 PM', end_time: '3:35 PM' } }],
    'Org',
    async () => [
      { date: '2026-09-02', startTime: '2:35 PM', endTime: '3:35 PM' },
      { date: '2026-09-09', startTime: '2:35 PM', endTime: '3:35 PM' },
    ],
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].sessionTimes, undefined);
  assertEquals(events[0].sessionDates, ['2026-09-02', '2026-09-09']);
});

Deno.test('a slot that differs becomes an override', async () => {
  const events = await calendarEventsFromRegistrations(
    [{ programs: { id: 'p1', curriculum: 'C', start_time: '2:35 PM', end_time: '3:35 PM' } }],
    'Org',
    async () => [
      { date: '2026-09-02', startTime: '2:35 PM', endTime: '3:35 PM' },
      { date: '2026-09-16', startTime: '1:20 PM', endTime: '2:20 PM' },
    ],
  );
  assertEquals(events[0].sessionTimes, { '2026-09-16': { start: '1:20 PM', end: '2:20 PM' } });
});
