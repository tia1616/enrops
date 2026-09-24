// The nudge schedule, asserted. These four numbers decide when real emails go
// to real instructors about real class-days, so they get a test that fails if
// anybody moves one without meaning to.
import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import {
  stageForDaysOut, daysBetween, allNudgeDaysOut, NUDGE_STAGES,
} from '../subNudgeStages.ts';

Deno.test('the schedule Jessica set, exactly', () => {
  assertEquals(stageForDaysOut(8)?.stage, 'instructor_1');
  assertEquals(stageForDaysOut(7)?.stage, 'provider_1');
  assertEquals(stageForDaysOut(4)?.stage, 'instructor_2');
  assertEquals(stageForDaysOut(3)?.stage, 'provider_2');
});

Deno.test('instructors are always chased BEFORE the provider hears anything', () => {
  // The whole point of the ordering: the people who can solve it get a day's
  // head start. If an edit ever makes a provider stage land on or before its
  // instructor stage, this fails.
  const inst = NUDGE_STAGES.filter((s) => s.audience === 'instructors').map((s) => s.daysOut);
  const prov = NUDGE_STAGES.filter((s) => s.audience === 'provider').map((s) => s.daysOut);
  assertEquals(inst.length, prov.length);
  for (let i = 0; i < inst.length; i++) {
    // Bigger daysOut = earlier. The instructor stage must be strictly earlier.
    assertEquals(inst[i] > prov[i], true, `instructor stage ${i} must precede provider stage ${i}`);
  }
});

Deno.test('a day that is not a threshold gets nothing', () => {
  for (const d of [1, 2, 5, 6, 9, 10, 14, 30]) {
    assertEquals(stageForDaysOut(d), null, `${d} days out should not nudge`);
  }
});

Deno.test('today and the past never nudge', () => {
  // Chasing somebody about a class that already happened is noise; a day that
  // arrived uncovered belongs on the board, not in an inbox.
  assertEquals(stageForDaysOut(0), null);
  assertEquals(stageForDaysOut(-1), null);
  assertEquals(stageForDaysOut(-8), null);
});

Deno.test('a non-integer distance never nudges', () => {
  assertEquals(stageForDaysOut(7.5), null);
  assertEquals(stageForDaysOut(NaN), null);
});

Deno.test('daysBetween counts calendar days', () => {
  assertEquals(daysBetween('2026-10-01', '2026-10-08'), 7);
  assertEquals(daysBetween('2026-09-30', '2026-10-08'), 8);
  assertEquals(daysBetween('2026-10-08', '2026-10-08'), 0);
  assertEquals(daysBetween('2026-10-09', '2026-10-08'), -1);
});

Deno.test('daysBetween survives a DST boundary', () => {
  // US DST ends 2026-11-01. A naive hours-based diff returns 6.958... here and
  // floors to 6, which would silently skip a threshold once a year.
  assertEquals(daysBetween('2026-10-29', '2026-11-05'), 7);
  assertEquals(daysBetween('2026-10-28', '2026-11-05'), 8);
});

Deno.test('the query helper offers every threshold and no others', () => {
  assertEquals(allNudgeDaysOut().sort((a, b) => a - b), [3, 4, 7, 8]);
});

Deno.test('Jessica two live days, walked end to end', () => {
  // 8 Oct Minecraft at Irvington, 12 Oct Pokemon at Oak Creek - the real offers
  // sent from prod on 24 Sept.
  assertEquals(stageForDaysOut(daysBetween('2026-09-30', '2026-10-08'))?.stage, 'instructor_1');
  assertEquals(stageForDaysOut(daysBetween('2026-10-01', '2026-10-08'))?.stage, 'provider_1');
  assertEquals(stageForDaysOut(daysBetween('2026-10-04', '2026-10-08'))?.stage, 'instructor_2');
  assertEquals(stageForDaysOut(daysBetween('2026-10-05', '2026-10-08'))?.stage, 'provider_2');
  // And nothing fires on the days between.
  assertEquals(stageForDaysOut(daysBetween('2026-10-02', '2026-10-08')), null);
  assertEquals(stageForDaysOut(daysBetween('2026-10-06', '2026-10-08')), null);
  // 12 Oct, same ladder, different dates.
  assertEquals(stageForDaysOut(daysBetween('2026-10-04', '2026-10-12'))?.stage, 'instructor_1');
  assertEquals(stageForDaysOut(daysBetween('2026-10-09', '2026-10-12'))?.stage, 'provider_2');
});
