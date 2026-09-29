// Pins which families a class-only automation may reach, and which a camp-only
// one may. Every case below is a real row shape the resolvers meet on prod.
//
// The bug these exist for shipped twice in one session: first the rule was
// written as a SQL test (`class_days IS NULL`) that disagreed with isCampProgram
// on an empty array, and then the corrected filter was computed into a variable
// that the send loop did not actually read. So these assert the OUTPUT of the
// filter, never that a filter was merely written.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { classProgramsOnly, classRegistrationsOnly, campRegistrationsOnly } from "./campAudience.ts";
import { isCampProgram } from "./noSchoolDates.ts";

const camp = { id: "camp", class_days: ["tuesday", "wednesday", "thursday"] };
const weekly = { id: "weekly", class_days: null };
// Storable: array_length('{}',1) is NULL, so CHECK programs_class_days_valid
// passes. It is a CLASS, because isCampProgram requires length > 0.
const emptyArray = { id: "empty", class_days: [] };
// A legacy row written before class_days existed.
const noColumn = { id: "legacy" };

Deno.test("classProgramsOnly keeps classes and drops camps", () => {
  const kept = classProgramsOnly([camp, weekly, emptyArray, noColumn]).map((p) => p.id);
  assertEquals(kept, ["weekly", "empty", "legacy"]);
});

Deno.test("classProgramsOnly survives null/undefined input", () => {
  assertEquals(classProgramsOnly(null), []);
  assertEquals(classProgramsOnly(undefined), []);
  assertEquals(classProgramsOnly([]), []);
});

Deno.test("an empty class_days is a CLASS, not a camp", () => {
  // The whole point of finding 1. If this flips, a weekly class is sent camp
  // copy with no day, and its school partner stops getting a roster.
  assertEquals(isCampProgram(emptyArray), false);
  assertEquals(classProgramsOnly([emptyArray]).length, 1);
  assertEquals(campRegistrationsOnly([{ programs: emptyArray }]).length, 0);
});

Deno.test("class and camp registration audiences are exact complements", () => {
  const rows = [
    { id: "r1", programs: camp },
    { id: "r2", programs: weekly },
    { id: "r3", programs: emptyArray },
    { id: "r4", programs: noColumn },
    { id: "r5", programs: null },
  ];
  const classes = classRegistrationsOnly(rows).map((r) => r.id);
  const camps = campRegistrationsOnly(rows).map((r) => r.id);

  assertEquals(classes, ["r2", "r3", "r4", "r5"]);
  assertEquals(camps, ["r1"]);

  // Nobody in both, nobody in neither — the property that stops a family being
  // emailed twice or dropped entirely when the two templates are both enabled.
  assertEquals(classes.length + camps.length, rows.length);
  assertEquals(classes.filter((id) => camps.includes(id)), []);
});

Deno.test("a registration with no joined program is treated as a class, not dropped", () => {
  // programs!inner means this should not happen, but failing this way keeps a
  // real family reachable instead of silently unmailable.
  assertEquals(classRegistrationsOnly([{ id: "x" }]).length, 1);
  assertEquals(campRegistrationsOnly([{ id: "x" }]).length, 0);
});
