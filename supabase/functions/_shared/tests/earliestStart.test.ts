// {{registration_close_date}} is counted back from the EARLIEST start date at a
// school. It used to render empty when a school's classes started on different
// days, leaving "Register by  to be sure of your spot" in the Dec 15 subject.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { earliestStartDate } from "../earliestStart.ts";

Deno.test("one class: its own start date", () => {
  assertEquals(earliestStartDate(["2027-01-11"]), "2027-01-11");
});

Deno.test("same day: that day", () => {
  assertEquals(earliestStartDate(["2027-01-11", "2027-01-11"]), "2027-01-11");
});

Deno.test("Jackson (Mon Jan 11 + Tue Jan 12) and Bonny Slope (Wed Jan 13 + Fri Jan 15): the earlier one, in any order", () => {
  assertEquals(earliestStartDate(["2027-01-12", "2027-01-11"]), "2027-01-11");
  assertEquals(earliestStartDate(["2027-01-15", "2027-01-13"]), "2027-01-13");
  assertEquals(earliestStartDate(["2027-01-13", "2027-01-15", "2027-01-14"]), "2027-01-13");
});

Deno.test("across a month or year boundary it still picks the earliest", () => {
  assertEquals(earliestStartDate(["2027-02-02", "2027-01-28"]), "2027-01-28");
  assertEquals(earliestStartDate(["2027-01-04", "2026-12-28"]), "2026-12-28");
});

Deno.test("any class with no usable start date -> null, never a guess from the others", () => {
  assertEquals(earliestStartDate(["2027-01-11", null]), null);
  assertEquals(earliestStartDate(["2027-01-11", undefined]), null);
  assertEquals(earliestStartDate(["2027-01-11", ""]), null);
  assertEquals(earliestStartDate(["2027-01-11", "January 12"]), null);
  assertEquals(earliestStartDate([]), null);
});

Deno.test("does not mutate its input", () => {
  const input = ["2027-01-15", "2027-01-13"];
  earliestStartDate(input);
  assertEquals(input, ["2027-01-15", "2027-01-13"]);
});

Deno.test("the sender uses it, and no longer blanks the token when dates differ", () => {
  const src = Deno.readTextFileSync("supabase/functions/marketing-touchpoint-send/index.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert(/earliestStartDate\(allPrograms\.map/.test(src), "registration_close_date must come from earliestStartDate");
  assert(!/oneSharedStart/.test(src), "the all-or-nothing 'one shared start' gate must be gone");
});
