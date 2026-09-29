// Pins which weekdays a program occupies — the answer the scheduling board uses
// for "does this instructor already teach that day", for counting days against
// their max, and for checking their stated availability.
//
// The failure this exists for: a camp's day_of_week holds only its FIRST day, so
// reading that column says a Mon-Thu camp is a Monday thing. The board then
// believes the instructor is free Tue, Wed and Thu and counts the camp as one
// day of work instead of four. Both are silent.
import { strict as assert } from "node:assert";
import test from "node:test";
import { programWeekdays } from "./programSchedule.js";

test("a weekly class occupies the single day it repeats on", () => {
  assert.deepEqual(programWeekdays({ day_of_week: "Wednesday", class_days: null }), ["wednesday"]);
});

test("a camp occupies EVERY day of its run, not just the first", () => {
  const camp = { day_of_week: "Monday", class_days: ["monday", "tuesday", "wednesday", "thursday"] };
  assert.deepEqual(programWeekdays(camp), ["monday", "tuesday", "wednesday", "thursday"]);
  // The specific regression: reading day_of_week alone would have said one day.
  assert.notDeepEqual(programWeekdays(camp), ["monday"]);
});

test("days come back in calendar order however they were stored", () => {
  assert.deepEqual(
    programWeekdays({ class_days: ["thursday", "monday", "wednesday"] }),
    ["monday", "wednesday", "thursday"],
  );
});

test("a camp that skips a day in the middle reports only the days it meets", () => {
  // A holiday week: Mon, Tue, then Thu. Must not be reported as Mon-Thu.
  assert.deepEqual(
    programWeekdays({ day_of_week: "Monday", class_days: ["monday", "tuesday", "thursday"] }),
    ["monday", "tuesday", "thursday"],
  );
});

test("weekend camp days survive — the caller decides whether it has a column for them", () => {
  assert.deepEqual(
    programWeekdays({ class_days: ["saturday", "sunday"] }),
    ["saturday", "sunday"],
  );
});

test("casing and stray whitespace in day_of_week still resolve", () => {
  assert.deepEqual(programWeekdays({ day_of_week: "FRIDAY" }), ["friday"]);
  assert.deepEqual(programWeekdays({ day_of_week: " tuesday " }), ["tuesday"]);
});

test("an empty class_days falls back to the weekday, matching isCampProgram", () => {
  // '{}' is storable and means CLASS, so it must behave like a weekly class here.
  assert.deepEqual(programWeekdays({ day_of_week: "Monday", class_days: [] }), ["monday"]);
});

test("nothing knowable returns [] rather than a guess", () => {
  assert.deepEqual(programWeekdays({}), []);
  assert.deepEqual(programWeekdays(null), []);
  assert.deepEqual(programWeekdays({ day_of_week: "Someday" }), []);
});
