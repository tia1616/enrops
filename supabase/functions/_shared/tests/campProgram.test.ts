// _shared/campProgram.ts, and its parity with the browser's formatDayLabel().
//
// THE BUG THIS PINS. A camp is a program with class_days set, and its
// day_of_week holds only its FIRST day. The three instructor-offer emails each
// had their own hand-written dayLabel(), each of which read day_of_week and
// stopped, so a Monday-to-Thursday winter break camp was offered to an
// instructor as "Mondays 9:00-3:00 - all term". Both halves of that are false,
// in the email that asks them to commit.
//
// This file is executable parity, not a text guard: src/lib/programSchedule.js
// is plain ESM with no JSX, so Deno imports it directly and both sides are RUN
// over the same rows. Same construction as cartFeeTwinParity.test.ts.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  anyCampProgram,
  campDayLabel,
  campRunLabel,
  isCampProgram,
  programRunLabel,
} from "../campProgram.ts";
import { isCampProgram as isCampProgramCron } from "../../lifecycle-automations-cron/noSchoolDates.ts";

const WEB = new URL("../../../../src/lib/programSchedule.js", import.meta.url);
const { formatDayLabel } = await import(WEB.href);

const CAMP_MON_THU = {
  class_days: ["monday", "tuesday", "wednesday", "thursday"],
  day_of_week: "Monday",
  first_session_date: "2026-12-21",
  end_date: "2026-12-24",
};

Deno.test("isCampProgram: an empty class_days is a CLASS, not a camp", () => {
  // The CHECK constraint permits '{}', and array_length('{}',1) is NULL, so a
  // CHECK written to forbid it passes anyway. Reading "not null" as "camp" is
  // the mistake this predicate exists to stop.
  assertEquals(isCampProgram({ class_days: [] }), false);
  assertEquals(isCampProgram({ class_days: null }), false);
  assertEquals(isCampProgram({}), false);
  assertEquals(isCampProgram(null), false);
  assertEquals(isCampProgram(CAMP_MON_THU), true);
});

Deno.test("isCampProgram: the cron's copy IS this copy", () => {
  // noSchoolDates.ts imports rather than redefining. If someone reinstates a
  // local definition there, this fails on the first row the two disagree about.
  for (
    const row of [
      CAMP_MON_THU,
      { class_days: [] },
      { class_days: null },
      { class_days: ["friday"] },
      {},
    ]
  ) {
    assertEquals(isCampProgramCron(row), isCampProgram(row));
  }
});

Deno.test("campDayLabel: a Mon-Thu camp is not 'Mondays'", () => {
  assertEquals(campDayLabel(CAMP_MON_THU), "Mon-Thu");
});

Deno.test("campDayLabel: a camp that skips a day lists its days", () => {
  // "Mon-Fri" would promise a Tuesday and a Thursday it does not meet.
  assertEquals(
    campDayLabel({ class_days: ["monday", "wednesday", "friday"] }),
    "Mon, Wed, Fri",
  );
});

Deno.test("campDayLabel: order comes from the calendar, not the array", () => {
  assertEquals(
    campDayLabel({ class_days: ["wednesday", "monday", "tuesday"] }),
    "Mon-Wed",
  );
});

Deno.test("campDayLabel: a one-day camp reads as one day", () => {
  assertEquals(campDayLabel({ class_days: ["friday"] }), "Fri");
});

Deno.test("campDayLabel: '' for a class, so the caller keeps its weekly label", () => {
  assertEquals(campDayLabel({ class_days: [], day_of_week: "Monday" }), "");
  assertEquals(campDayLabel({ day_of_week: "Monday" }), "");
  // class_days holding nothing recognisable must also fall through rather than
  // render an empty segment between two separator dots.
  assertEquals(campDayLabel({ class_days: ["someday"] }), "");
});

Deno.test("campDayLabel matches the browser's formatDayLabel for every camp shape", () => {
  // The instructor reads this in an email and then opens the portal card, which
  // renders formatDayLabel(). The two describing the same camp differently is
  // the confusion this replaces.
  const shapes = [
    ["monday", "tuesday", "wednesday", "thursday"],
    ["monday", "tuesday", "wednesday", "thursday", "friday"],
    ["monday", "wednesday", "friday"],
    ["tuesday", "thursday"],
    ["friday"],
    ["wednesday", "monday", "tuesday"],
    ["saturday", "sunday"],
  ];
  for (const class_days of shapes) {
    const row = { class_days, day_of_week: "Monday" };
    assertEquals(campDayLabel(row), formatDayLabel(row), class_days.join("+"));
  }
});

Deno.test("campRunLabel: a camp's dates replace 'all term'", () => {
  assertEquals(campRunLabel(CAMP_MON_THU), "December 21-24");
});

Deno.test("campRunLabel: a camp crossing a month names both months", () => {
  assertEquals(
    campRunLabel({
      class_days: ["monday", "tuesday"],
      first_session_date: "2026-12-28",
      end_date: "2027-01-02",
    }),
    "December 28-January 2",
  );
});

Deno.test("campRunLabel: a one-day camp is one date, not a range to itself", () => {
  assertEquals(
    campRunLabel({
      class_days: ["friday"],
      first_session_date: "2026-12-24",
      end_date: "2026-12-24",
    }),
    "December 24",
  );
});

Deno.test("campRunLabel: dates are read locally, not in UTC", () => {
  // new Date('2026-12-21') is midnight UTC, which is 21 December only for
  // people at or ahead of it. The T00:00:00 form is what the rest of these
  // emails already use for a deadline.
  assertEquals(campRunLabel(CAMP_MON_THU).startsWith("December 21"), true);
});

Deno.test("campRunLabel: no dates means no claim, never 'all term'", () => {
  assertEquals(campRunLabel({ class_days: ["monday"] }), "");
  assertEquals(
    campRunLabel({ class_days: ["monday"], first_session_date: "not-a-date" }),
    "",
  );
  // Only the end date missing still says what is known.
  assertEquals(
    campRunLabel({ class_days: ["monday"], first_session_date: "2026-12-21" }),
    "December 21",
  );
});

Deno.test("programRunLabel: a class still says 'all term', unchanged", () => {
  // The safety property of this whole change: only a camp reads differently.
  assertEquals(programRunLabel({ class_days: [], day_of_week: "Monday" }), "all term");
  assertEquals(programRunLabel({ day_of_week: "Monday" }), "all term");
  assertEquals(programRunLabel(null), "all term");
  assertEquals(programRunLabel(CAMP_MON_THU), "December 21-24");
});

Deno.test("anyCampProgram: only flips the intro sentence when a camp is present", () => {
  assertEquals(anyCampProgram([{ class_days: [] }, { day_of_week: "Monday" }]), false);
  assertEquals(anyCampProgram([]), false);
  assertEquals(anyCampProgram(null), false);
  assertEquals(anyCampProgram([{ class_days: [] }, CAMP_MON_THU]), true);
});
