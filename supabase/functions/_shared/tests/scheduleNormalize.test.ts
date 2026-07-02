// Tests for scheduleNormalize. Pure-function tests; no Supabase/network.
// Run: deno test supabase/functions/_shared/tests/scheduleNormalize.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  normalizeDay,
  normalizeTime,
  normalizeScheduleRow,
} from "../scheduleNormalize.ts";

Deno.test("normalizeDay — full names, abbreviations, dots, case", () => {
  assertEquals(normalizeDay("Monday"), "Monday");
  assertEquals(normalizeDay("monday"), "Monday");
  assertEquals(normalizeDay("MON"), "Monday");
  assertEquals(normalizeDay("Mon."), "Monday");
  assertEquals(normalizeDay(" tues "), "Tuesday");
  assertEquals(normalizeDay("weds"), "Wednesday");
  assertEquals(normalizeDay("Thurs"), "Thursday");
  assertEquals(normalizeDay("SAT"), "Saturday");
});

Deno.test("normalizeDay — unrecognizable returns null (never guesses)", () => {
  assertEquals(normalizeDay("someday"), null);
  assertEquals(normalizeDay(""), null);
  assertEquals(normalizeDay(null), null);
  assertEquals(normalizeDay(undefined), null);
  assertEquals(normalizeDay("M/W/F"), null); // multi-day cell — reject, don't guess
});

Deno.test("normalizeTime — 12h forms canonicalize to 'H:MM AM/PM'", () => {
  assertEquals(normalizeTime("4pm"), "4:00 PM");
  assertEquals(normalizeTime("4 PM"), "4:00 PM");
  assertEquals(normalizeTime("4:00pm"), "4:00 PM");
  assertEquals(normalizeTime("4:05 PM"), "4:05 PM");
  assertEquals(normalizeTime("9:30 a.m."), "9:30 AM");
  assertEquals(normalizeTime("12pm"), "12:00 PM");
  assertEquals(normalizeTime("12am"), "12:00 AM");
});

Deno.test("normalizeTime — 24h clock converts to 12h", () => {
  assertEquals(normalizeTime("16:00"), "4:00 PM");
  assertEquals(normalizeTime("09:30"), "9:30 AM");
  assertEquals(normalizeTime("00:15"), "12:15 AM");
  assertEquals(normalizeTime("13:45"), "1:45 PM");
  assertEquals(normalizeTime("4:00"), "4:00 AM"); // no meridiem, <12 -> AM
});

Deno.test("normalizeTime — junk returns null", () => {
  assertEquals(normalizeTime(""), null);
  assertEquals(normalizeTime(null), null);
  assertEquals(normalizeTime("lunchtime"), null);
  assertEquals(normalizeTime("25:00"), null);
  assertEquals(normalizeTime("4:75 pm"), null);
  assertEquals(normalizeTime("13pm"), null); // 13 invalid with explicit meridiem
});

Deno.test("normalizeScheduleRow — happy path builds a clean row", () => {
  const res = normalizeScheduleRow({
    title: "  Beginner Group Class ",
    day_of_week: "mon",
    start_time: "4pm",
    end_time: "17:00",
    location_text: "Fremont Studio",
    instructor_name: "Coach D",
    instructor_email: "Coach.D@Example.com",
    age_min: "grade 1",
    age_max: "5",
    capacity: "12 kids",
    notes: "bring a board",
  });
  assertEquals(res.ok, true);
  if (!res.ok) return;
  assertEquals(res.row.title, "Beginner Group Class");
  assertEquals(res.row.day_of_week, "Monday");
  assertEquals(res.row.start_time, "4:00 PM");
  assertEquals(res.row.end_time, "5:00 PM");
  assertEquals(res.row.location_text, "Fremont Studio");
  assertEquals(res.row.instructor_name, "Coach D");
  assertEquals(res.row.instructor_email, "coach.d@example.com");
  assertEquals(res.row.age_min, 1);
  assertEquals(res.row.age_max, 5);
  assertEquals(res.row.capacity, 12);
  assertEquals(res.row.notes, "bring a board");
});

Deno.test("normalizeScheduleRow — optional fields default to null", () => {
  const res = normalizeScheduleRow({ title: "Open Play", day_of_week: "Friday" });
  assertEquals(res.ok, true);
  if (!res.ok) return;
  assertEquals(res.row.start_time, null);
  assertEquals(res.row.end_time, null);
  assertEquals(res.row.location_text, null);
  assertEquals(res.row.instructor_email, null);
  assertEquals(res.row.age_min, null);
  assertEquals(res.row.capacity, null);
});

Deno.test("normalizeScheduleRow — reversed age pair is swapped, not dropped", () => {
  const res = normalizeScheduleRow({ title: "X", day_of_week: "Mon", age_min: "10", age_max: "6" });
  assertEquals(res.ok, true);
  if (!res.ok) return;
  assertEquals(res.row.age_min, 6);
  assertEquals(res.row.age_max, 10);
});

Deno.test("normalizeScheduleRow — rejects missing title and bad day with reasons", () => {
  const noTitle = normalizeScheduleRow({ title: "  ", day_of_week: "Mon" });
  assertEquals(noTitle.ok, false);
  if (!noTitle.ok) assertEquals(noTitle.reason, "missing_title");

  const badDay = normalizeScheduleRow({ title: "Class", day_of_week: "someday" });
  assertEquals(badDay.ok, false);
  if (!badDay.ok) assertEquals(badDay.reason, "bad_day");
});
