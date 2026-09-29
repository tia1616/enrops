// Pins what the automation test/preview picker offers for each template.
//
// The failure this guards: welcome_camp's picker listed only legacy
// camp_sessions rows, so the camps an operator builds today (a program with
// class_days set) never appeared. Copy was approved against data the sending
// code path never touches. A picker that silently omits the thing you are about
// to send is worse than no picker.
import { strict as assert } from "node:assert";
import test from "node:test";
import { buildTestSources } from "./automationTestSources.js";

const campProgram = {
  id: "p-camp",
  curriculum: "Winter Break Robotics Camp",
  class_days: ["monday", "tuesday", "wednesday"],
  first_session_date: "2026-12-21",
  program_locations: { name: "Capitol Library" },
};
const classProgram = {
  id: "p-class",
  curriculum: "Minecraft Coders",
  class_days: null,
  first_session_date: "2026-10-06",
  program_locations: { name: "Edison Elementary" },
};
// Storable (array_length of '{}' is NULL so the CHECK passes) and a CLASS.
const emptyArrayProgram = { id: "p-empty", curriculum: "Odd One", class_days: [] };
const legacyCamp = {
  id: "cs-1",
  curriculum_name: "Summer LEGO Week 1",
  location_name: "Capitol Library",
  starts_on: "2026-07-06",
};

test("a camps template offers camp PROGRAMS, not just legacy camp sessions", () => {
  const out = buildTestSources("camps", [legacyCamp], [campProgram, classProgram]);
  const values = out.map((o) => o.value);
  assert.deepEqual(values, ["camp:cs-1", "program:p-camp"]);
  // The regression: before the fix this list held only "camp:cs-1".
  assert.ok(values.includes("program:p-camp"));
  assert.ok(!values.includes("program:p-class"));
});

test("an afterschool template never offers a camp", () => {
  const out = buildTestSources("afterschool", [legacyCamp], [campProgram, classProgram]);
  assert.deepEqual(out.map((o) => o.value), ["program:p-class"]);
});

test("'both' offers every kind", () => {
  const out = buildTestSources("both", [legacyCamp], [campProgram, classProgram]);
  assert.deepEqual(out.map((o) => o.value), ["camp:cs-1", "program:p-camp", "program:p-class"]);
});

test("a camp program is labelled Camp, a class is labelled After-school", () => {
  const [camp] = buildTestSources("camps", [], [campProgram]);
  assert.equal(camp.label, "Camp · Winter Break Robotics Camp — Capitol Library (Dec 21, 2026)");
  const [klass] = buildTestSources("afterschool", [], [classProgram]);
  assert.equal(klass.label, "After-school · Minecraft Coders — Edison Elementary (Oct 6, 2026)");
});

test("an empty class_days counts as a CLASS in the picker too", () => {
  // Must agree with isCampProgram and with the cron resolvers, or an operator
  // previews the wrong template for that row.
  assert.deepEqual(buildTestSources("camps", [], [emptyArrayProgram]).map((o) => o.value), []);
  assert.deepEqual(
    buildTestSources("afterschool", [], [emptyArrayProgram]).map((o) => o.value),
    ["program:p-empty"],
  );
});

test("no template type, or no rows, yields no options rather than throwing", () => {
  assert.deepEqual(buildTestSources(null, [legacyCamp], [campProgram]), []);
  assert.deepEqual(buildTestSources("both", null, null), []);
  assert.deepEqual(buildTestSources("both", undefined, undefined), []);
});
