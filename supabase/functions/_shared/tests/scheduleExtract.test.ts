// Tests for scheduleExtract. Pure-function tests; no Supabase/network.
// Run: deno test supabase/functions/_shared/tests/scheduleExtract.test.ts

import { assertEquals, assertThrows } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { parseScheduleRows, ScheduleExtractError } from "../scheduleExtract.ts";

Deno.test("parses a clean JSON array", () => {
  const rows = parseScheduleRows(JSON.stringify([
    { title: "Beginner Group", day_of_week: "Monday", start_time: "4pm", end_time: "5pm" },
    { title: "Weekend Club", day_of_week: "Saturday", location_text: "Studio" },
  ]));
  assertEquals(rows.length, 2);
  assertEquals(rows[0].title, "Beginner Group");
  assertEquals(rows[0].day_of_week, "Monday");
  assertEquals(rows[1].location_text, "Studio");
});

Deno.test("strips ```json fences and surrounding prose", () => {
  const raw = 'Here is the schedule:\n```json\n[{"title":"Chess 101","day_of_week":"Tue"}]\n```\nLet me know!';
  const rows = parseScheduleRows(raw);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].title, "Chess 101");
  assertEquals(rows[0].day_of_week, "Tue");
});

Deno.test("coerces numbers to strings and drops unknown keys", () => {
  const rows = parseScheduleRows(JSON.stringify([
    { title: "Club", day_of_week: "Fri", age_min: 6, age_max: 10, capacity: 12, organization_id: "hacked", source: "manual" },
  ]));
  assertEquals(rows[0].age_min, "6");
  assertEquals(rows[0].capacity, "12");
  // Unknown keys never make it onto the row (no org/source smuggling).
  assertEquals("organization_id" in rows[0], false);
  assertEquals("source" in rows[0], false);
});

Deno.test("skips non-object and wholly-empty entries", () => {
  const rows = parseScheduleRows(JSON.stringify([
    "not an object",
    { title: null, day_of_week: null },
    { title: "Real", day_of_week: "Mon" },
    123,
  ]));
  assertEquals(rows.length, 1);
  assertEquals(rows[0].title, "Real");
});

Deno.test("empty array is a valid (no classes) result", () => {
  assertEquals(parseScheduleRows("[]"), []);
});

Deno.test("throws on empty / non-array / unparseable replies", () => {
  assertThrows(() => parseScheduleRows(""), ScheduleExtractError);
  assertThrows(() => parseScheduleRows("I couldn't find a schedule."), ScheduleExtractError);
  assertThrows(() => parseScheduleRows('{"title":"x"}'), ScheduleExtractError); // object, not array
  assertThrows(() => parseScheduleRows("[not valid json"), ScheduleExtractError);
});
