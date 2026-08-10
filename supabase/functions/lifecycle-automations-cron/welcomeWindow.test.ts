// Unit tests for the Welcome audience window. Run: deno test welcomeWindow.test.ts
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  orgToday,
  orgHour,
  withinSendingHours,
  addDays,
  lastRunDay,
  nextSessionOnOrAfter,
  lateJoinFloor,
  sessionsOnOrAfter,
  welcomeVerdict,
  LATE_JOIN_MAX_AGE_DAYS,
} from "./welcomeWindow.ts";

// 2026-08-10 21:30 UTC = 2:30pm Los Angeles, 5:30pm New York (same calendar
// day in both); 2026-08-11 03:30 UTC is still Aug 10 evening in both zones.
const AUG10_EVE_UTC = new Date("2026-08-11T03:30:00Z");

Deno.test("orgToday reads the ORG's calendar day, not the server's", () => {
  // 03:30 UTC on the 11th is still the 10th on both US coasts. A UTC 'today'
  // would say the 11th and treat a class starting the 10th as already past.
  assertEquals(orgToday("America/Los_Angeles", AUG10_EVE_UTC), "2026-08-10");
  assertEquals(orgToday("America/New_York", AUG10_EVE_UTC), "2026-08-10");
  assertEquals(orgToday("UTC", AUG10_EVE_UTC), "2026-08-11");
});

Deno.test("orgToday falls back to UTC on a missing or bogus timezone", () => {
  assertEquals(orgToday(null, AUG10_EVE_UTC), "2026-08-11");
  assertEquals(orgToday("Not/AZone", AUG10_EVE_UTC), "2026-08-11");
});

Deno.test("orgHour is org-local and never renders midnight as 24", () => {
  assertEquals(orgHour("America/Los_Angeles", AUG10_EVE_UTC), 20);
  assertEquals(orgHour("America/New_York", AUG10_EVE_UTC), 23);
  // Midnight LA = 07:00 UTC. The h23 cycle must give 0, not 24.
  assertEquals(orgHour("America/Los_Angeles", new Date("2026-08-10T07:00:00Z")), 0);
});

Deno.test("withinSendingHours keeps sweeps out of the middle of the night", () => {
  assertEquals(withinSendingHours(0), false);
  assertEquals(withinSendingHours(6), false);
  assertEquals(withinSendingHours(7), true);
  assertEquals(withinSendingHours(20), true);
  assertEquals(withinSendingHours(21), false);
});

Deno.test("addDays crosses months and years without timezone drift", () => {
  assertEquals(addDays("2026-08-10", 7), "2026-08-17");
  assertEquals(addDays("2026-08-28", 7), "2026-09-04");
  assertEquals(addDays("2026-12-29", 7), "2027-01-05");
  assertEquals(addDays("2026-08-10", 0), "2026-08-10");
});

Deno.test("lastRunDay prefers real session dates, then ends_on, else null", () => {
  assertEquals(lastRunDay({ startsOn: "2026-08-31", sessionDates: ["2026-08-31", "2026-11-16", "2026-09-07"] }), "2026-11-16");
  assertEquals(lastRunDay({ startsOn: "2026-08-03", endsOn: "2026-08-07" }), "2026-08-07");
  // Nothing to go on: null, so the caller refuses rather than guesses.
  assertEquals(lastRunDay({ startsOn: "2026-08-03" }), null);
  assertEquals(lastRunDay({ startsOn: "2026-08-03", sessionDates: [] }), null);
});

Deno.test("nextSessionOnOrAfter returns the family's next real session", () => {
  const sessions = ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"];
  assertEquals(nextSessionOnOrAfter(sessions, "2026-09-08"), "2026-09-14");
  // Today IS a session day: that is their next one.
  assertEquals(nextSessionOnOrAfter(sessions, "2026-09-07"), "2026-09-07");
  assertEquals(nextSessionOnOrAfter(sessions, "2026-09-22"), null);
  assertEquals(nextSessionOnOrAfter(null, "2026-09-08"), null);
});

Deno.test("lateJoinFloor takes whichever is later: enabled_at or the age cap", () => {
  const now = new Date("2026-08-10T15:00:00Z");
  const cap = now.getTime() - LATE_JOIN_MAX_AGE_DAYS * 86400000;
  // Enabled long ago -> the age cap governs.
  assertEquals(lateJoinFloor("2026-06-26T20:58:00Z", now), cap);
  // Enabled recently -> enabled_at governs, so switching it on cannot back-mail.
  assertEquals(lateJoinFloor("2026-08-10T15:14:50Z", now), Date.parse("2026-08-10T15:14:50Z"));
});

Deno.test("lateJoinFloor REFUSES rather than falling back when enabled_at is unknown", () => {
  // Falling back to the 30-day cap here would turn "cannot back-mail" into
  // "can mail anyone from the last 30 days" for any row enabled by SQL.
  const now = new Date("2026-08-10T15:00:00Z");
  assertEquals(lateJoinFloor(null, now), null);
  assertEquals(lateJoinFloor(undefined, now), null);
  assertEquals(lateJoinFloor("not-a-date", now), null);
});

Deno.test("a late join is refused outright when enabled_at is unknown", () => {
  const v = welcomeVerdict({
    startsOn: "2026-08-31",
    sessionDates: ["2026-08-31", "2026-11-16"],
    registeredAt: "2026-09-08T14:00:00Z", // brand new, would otherwise qualify
  }, { ...W, enabledAt: null });
  assertEquals(v.eligible, false);
  assertEquals(v.reason, "enabled_at_unknown");
});

Deno.test("an ON-TIME signup is unaffected by a missing enabled_at", () => {
  // The fence exists to stop back-mailing; it must not block the normal path.
  const v = welcomeVerdict({ startsOn: "2026-09-14" }, { ...W, enabledAt: null });
  assertEquals(v.eligible, true);
  assertEquals(v.reason, "on_time");
});

Deno.test("sessionsOnOrAfter drops sessions a late joiner never had", () => {
  const sessions = ["2026-08-08", "2026-08-15", "2026-08-22", "2026-08-29"];
  // Joined Aug 10: Aug 8 is not theirs, so it must not be listed OR counted.
  assertEquals(sessionsOnOrAfter(sessions, "2026-08-10"), ["2026-08-15", "2026-08-22", "2026-08-29"]);
  // On time: the program hasn't started, so this is a no-op and the block is
  // byte-for-byte what it always was.
  assertEquals(sessionsOnOrAfter(sessions, "2026-08-01"), sessions);
  // A session TODAY still counts as theirs.
  assertEquals(sessionsOnOrAfter(sessions, "2026-08-15").length, 3);
  assertEquals(sessionsOnOrAfter(null, "2026-08-10"), []);
});

// ─── welcomeVerdict ─────────────────────────────────────────────────────────

const NOW = new Date("2026-09-08T16:00:00Z");
const W = {
  today: "2026-09-08",
  windowEnd: "2026-09-15",
  enabledAt: "2026-08-10T15:14:50Z",
  now: NOW,
};

Deno.test("on-time signups behave exactly as before, showing the program start", () => {
  const v = welcomeVerdict({ startsOn: "2026-09-14", registeredAt: "2026-09-08T15:00:00Z" }, W);
  assertEquals(v.eligible, true);
  assertEquals(v.late, false);
  assertEquals(v.firstDay, "2026-09-14"); // the program's own start date
  assertEquals(v.reason, "on_time");
});

Deno.test("a program starting TODAY still qualifies (the same-day case)", () => {
  const v = welcomeVerdict({ startsOn: "2026-09-08", registeredAt: "2026-09-08T15:30:00Z" }, W);
  assertEquals(v.eligible, true);
  assertEquals(v.late, false);
  assertEquals(v.firstDay, "2026-09-08");
});

Deno.test("beyond days_before it waits — the window still has an upper edge", () => {
  const v = welcomeVerdict({ startsOn: "2026-09-16", registeredAt: "2026-09-08T15:00:00Z" }, W);
  assertEquals(v.eligible, false);
  assertEquals(v.reason, "starts_after_window");
});

Deno.test("late join mid-term: eligible, and told their NEXT session", () => {
  const v = welcomeVerdict({
    startsOn: "2026-08-31",
    sessionDates: ["2026-08-31", "2026-09-07", "2026-09-14", "2026-11-16"],
    registeredAt: "2026-09-08T14:00:00Z",
  }, W);
  assertEquals(v.eligible, true);
  assertEquals(v.late, true);
  assertEquals(v.firstDay, "2026-09-14"); // never "starts Monday, August 31"
});

Deno.test("late join to a term that already finished gets nothing", () => {
  const v = welcomeVerdict({
    startsOn: "2026-05-04",
    sessionDates: ["2026-05-04", "2026-05-11"],
    registeredAt: "2026-09-08T14:00:00Z",
  }, W);
  assertEquals(v.eligible, false);
  assertEquals(v.reason, "already_over");
});

Deno.test("a started program with no knowable end is refused, not guessed", () => {
  const v = welcomeVerdict({ startsOn: "2026-08-31", registeredAt: "2026-09-08T14:00:00Z" }, W);
  assertEquals(v.eligible, false);
  assertEquals(v.reason, "end_unknown");
});

Deno.test("switching the automation on cannot back-mail an in-flight term", () => {
  // Enrolled in July, program still running, but Welcome was only turned on in
  // August: this family is not new, so they must not be mailed now.
  const v = welcomeVerdict({
    startsOn: "2026-08-31",
    sessionDates: ["2026-08-31", "2026-09-14", "2026-11-16"],
    registeredAt: "2026-07-02T14:00:00Z",
  }, W);
  assertEquals(v.eligible, false);
  assertEquals(v.reason, "registered_before_floor");
});

Deno.test("a stale registration cannot trigger months later", () => {
  const v = welcomeVerdict({
    startsOn: "2026-08-31",
    sessionDates: ["2026-08-31", "2026-11-16"],
    registeredAt: "2026-08-01T14:00:00Z", // after enabled_at, but 38 days old
  }, { ...W, enabledAt: "2026-01-01T00:00:00Z" });
  assertEquals(v.eligible, false);
  assertEquals(v.reason, "registered_before_floor");
});

Deno.test("a camp running right now: late join lands on today", () => {
  const v = welcomeVerdict({
    startsOn: "2026-09-07",
    endsOn: "2026-09-11",
    registeredAt: "2026-09-08T13:00:00Z",
  }, W);
  assertEquals(v.eligible, true);
  assertEquals(v.late, true);
  assertEquals(v.firstDay, "2026-09-08");
});

Deno.test("a camp that ended yesterday is refused", () => {
  const v = welcomeVerdict({
    startsOn: "2026-08-31",
    endsOn: "2026-09-04",
    registeredAt: "2026-09-08T13:00:00Z",
  }, W);
  assertEquals(v.eligible, false);
  assertEquals(v.reason, "already_over");
});

Deno.test("no start date, or no registered_at on a late row, is refused", () => {
  assertEquals(welcomeVerdict({ startsOn: null }, W).reason, "no_start_date");
  assertEquals(
    welcomeVerdict({ startsOn: "2026-08-31", sessionDates: ["2026-11-16"] }, W).reason,
    "no_registered_at",
  );
});
