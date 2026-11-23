import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { finalPhotoFire, teachersOnDay } from "./finalPhotoReminder.ts";

Deno.test("finalPhotoFire: morning of the last class", () => {
  assertEquals(finalPhotoFire("2026-12-01", "2026-12-01"), "day_of");
});

Deno.test("finalPhotoFire: exactly a week before", () => {
  assertEquals(finalPhotoFire("2026-12-08", "2026-12-01"), "week_before");
});

Deno.test("finalPhotoFire: catch-up window 2 to 7 days out", () => {
  assertEquals(finalPhotoFire("2026-12-03", "2026-12-01"), "week_before");
  assertEquals(finalPhotoFire("2026-12-05", "2026-12-01"), "week_before");
});

Deno.test("finalPhotoFire: nothing the day before, 8+ days out, or after", () => {
  assertEquals(finalPhotoFire("2026-12-02", "2026-12-01"), null);
  assertEquals(finalPhotoFire("2026-12-09", "2026-12-01"), null);
  assertEquals(finalPhotoFire("2026-11-30", "2026-12-01"), null);
  assertEquals(finalPhotoFire(null, "2026-12-01"), null);
});

Deno.test("finalPhotoFire: crosses a month and DST boundary by calendar day", () => {
  assertEquals(finalPhotoFire("2027-03-15", "2027-03-08"), "week_before");
  assertEquals(finalPhotoFire("2027-03-02", "2027-02-23"), "week_before");
});

Deno.test("teachersOnDay: lead teaches when no sub", () => {
  assertEquals(teachersOnDay([{ assignmentId: "a1", instructorId: "lead" }], []), ["lead"]);
});

Deno.test("teachersOnDay: settled sub replaces the lead on that assignment only", () => {
  assertEquals(
    teachersOnDay(
      [{ assignmentId: "a1", instructorId: "lead" }, { assignmentId: "a2", instructorId: "asst" }],
      [{ assignmentId: "a1", subInstructorId: "sub" }],
    ),
    ["sub", "asst"],
  );
});

Deno.test("teachersOnDay: dedupes one person on two assignments", () => {
  assertEquals(
    teachersOnDay(
      [{ assignmentId: "a1", instructorId: "x" }, { assignmentId: "a2", instructorId: "y" }],
      [{ assignmentId: "a2", subInstructorId: "x" }],
    ),
    ["x"],
  );
});
