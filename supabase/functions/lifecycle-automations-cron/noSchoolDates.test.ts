// Unit tests for the no_school_day pure date logic. Run: deno test noSchoolDates.test.ts
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  cleanNoSchoolDates,
  toClosurePeriods,
  termToSchoolYear,
  nsdWeekdayLower,
  nsdWeekdaysStrictlyBetween,
  periodFires,
  formatDateList,
} from "./noSchoolDates.ts";

Deno.test("cleanNoSchoolDates drops junk, past dates; sorts ascending", () => {
  const raw = [
    { date: "2026-07-20", reason: "b" },
    { date: "0027-01-12", reason: "typo year <2000" }, // the real prod typo
    { date: "not-a-date", reason: "junk" },
    { date: "2026-07-13", reason: "a" },
    { date: "2026-01-01", reason: "in the past vs today 2026-07-09" },
    { reason: "no date field" },
  ];
  const clean = cleanNoSchoolDates(raw, "2026-07-09");
  assertEquals(clean.map((d) => d.iso), ["2026-07-13", "2026-07-20"]);
  assertEquals(clean[0].reason, "a"); // sorted, reason preserved
});

Deno.test("cleanNoSchoolDates handles non-array input", () => {
  assertEquals(cleanNoSchoolDates(null, "2026-07-09"), []);
  assertEquals(cleanNoSchoolDates(undefined, "2026-07-09"), []);
  assertEquals(cleanNoSchoolDates("[]", "2026-07-09"), []);
});

Deno.test("weekdaysStrictlyBetween: Fri→Mon is 0 (weekend only), Mon→Thu is 2", () => {
  assertEquals(nsdWeekdaysStrictlyBetween("2026-07-17", "2026-07-20"), 0); // Fri → Mon: Sat+Sun only
  assertEquals(nsdWeekdaysStrictlyBetween("2026-07-13", "2026-07-14"), 0); // consecutive
  assertEquals(nsdWeekdaysStrictlyBetween("2026-07-13", "2026-07-16"), 2); // Mon → Thu: Tue+Wed
});

Deno.test("toClosurePeriods: Thanksgiving Thu+Fri collapse to one period", () => {
  const dates = cleanNoSchoolDates(
    [{ date: "2026-11-26", reason: "Thanksgiving" }, { date: "2026-11-27", reason: "Break" }],
    "2026-07-09",
  );
  const periods = toClosurePeriods(dates);
  assertEquals(periods.length, 1);
  assertEquals(periods[0].startIso, "2026-11-26");
  assertEquals(periods[0].endIso, "2026-11-27");
});

Deno.test("toClosurePeriods: a two-week break bridges the weekend into ONE period", () => {
  // This is the seeded staging scenario: without weekend-bridging, 07-20 would
  // start a separate period after the send window and the second Monday would be
  // silently missed. Bridging keeps 07-13..07-24 as one closure.
  const raw = ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17",
    "2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"]
    .map((date) => ({ date, reason: "Summer Institute" }));
  const periods = toClosurePeriods(cleanNoSchoolDates(raw, "2026-07-09"));
  assertEquals(periods.length, 1);
  assertEquals(periods[0].startIso, "2026-07-13");
  assertEquals(periods[0].endIso, "2026-07-24");
});

Deno.test("toClosurePeriods: two isolated inservice days split into two periods", () => {
  const raw = [{ date: "2026-10-12", reason: "Indigenous Peoples Day" }, // Monday
    { date: "2026-10-30", reason: "Grading Day" }]; // Friday, weeks later
  const periods = toClosurePeriods(cleanNoSchoolDates(raw, "2026-07-09"));
  assertEquals(periods.length, 2);
  assertEquals(periods.map((p) => p.startIso), ["2026-10-12", "2026-10-30"]);
});

Deno.test("termToSchoolYear mirrors the SQL function", () => {
  assertEquals(termToSchoolYear("FA26"), "2026-2027");
  assertEquals(termToSchoolYear("WI27"), "2026-2027");
  assertEquals(termToSchoolYear("SP27"), "2026-2027");
  assertEquals(termToSchoolYear("SU26"), null); // camps never follow the school calendar
  assertEquals(termToSchoolYear("bogus"), null);
  assertEquals(termToSchoolYear(null), null);
  // Strict-suffix guard: must reject what SQL's ::integer cast rejects, so the TS
  // and SQL mirrors never classify a malformed term differently.
  assertEquals(termToSchoolYear("FA26x"), null);
  assertEquals(termToSchoolYear("FA2 "), null);
});

Deno.test("nsdWeekdayLower is timezone-stable", () => {
  assertEquals(nsdWeekdayLower("2026-07-13"), "monday");
  assertEquals(nsdWeekdayLower("2026-07-17"), "friday");
});

Deno.test("periodFires: normal 7-days-ahead send fires on the send day, not before", () => {
  // Single-day closure 2026-09-14 (Mon), days_before=7, enabled long ago.
  assertEquals(periodFires("2026-09-14", "2026-09-14", "2026-09-07", 7, "2026-08-01"), true);
  assertEquals(periodFires("2026-09-14", "2026-09-14", "2026-09-06", 7, "2026-08-01"), false); // 1 day too early
});

Deno.test("periodFires: NO on-enable back-catalog blast (the blocker fix)", () => {
  // Operator enables today (07-09); a closure starts 07-13 (4 days out). Its send
  // day was 07-06, before enabling → must NOT fire on the enable day.
  assertEquals(periodFires("2026-07-13", "2026-07-13", "2026-07-09", 7, "2026-07-09"), false);
  // Same, enabled well after the send window opened → still no retroactive blast.
  assertEquals(periodFires("2026-09-14", "2026-09-14", "2026-09-12", 7, "2026-09-10"), false);
});

Deno.test("periodFires: catch-up during a break, then stops after it ends", () => {
  // Two-week break 07-13..07-24, enabled long ago. If the send was somehow missed,
  // it still fires any day the break is ongoing (dedup + stable key ⇒ once).
  assertEquals(periodFires("2026-07-13", "2026-07-24", "2026-07-20", 7, "2026-06-01"), true);
  // After the break fully ends, never fires.
  assertEquals(periodFires("2026-07-13", "2026-07-24", "2026-07-25", 7, "2026-06-01"), false);
});

Deno.test("formatDateList reads naturally for 1, 2, and 3+ dates", () => {
  assertEquals(formatDateList(["2026-07-13"]), "Monday, July 13");
  assertEquals(formatDateList(["2026-07-13", "2026-07-20"]), "Monday, July 13 and Monday, July 20");
  assertEquals(
    formatDateList(["2026-07-13", "2026-07-20", "2026-07-27"]),
    "Monday, July 13, Monday, July 20, and Monday, July 27",
  );
});
