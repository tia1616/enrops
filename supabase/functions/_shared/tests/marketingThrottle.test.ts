import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  DEFAULT_THROTTLE_DAYS,
  isDeadlineReminderLabel,
  splitByThrottle,
  THROTTLE_SLACK_HOURS,
  throttleDays,
  throttleGapHours,
} from "../marketingThrottle.ts";

Deno.test("a 3-day gap is shortened by the slack so a late cron tick is not held back", () => {
  assertEquals(throttleGapHours(3), 3 * 24 - THROTTLE_SLACK_HOURS);
});

Deno.test("0 days turns the throttle off, on purpose", () => {
  assertEquals(throttleGapHours(0), 0);
  assertEquals(throttleGapHours(-2), 0);
});

Deno.test("an unreadable setting falls back to the default, never to off", () => {
  const fallback = throttleGapHours(DEFAULT_THROTTLE_DAYS);
  assertEquals(throttleGapHours(null), fallback);
  assertEquals(throttleGapHours(undefined), fallback);
  assertEquals(throttleGapHours("3"), fallback);
  assertEquals(throttleGapHours(NaN), fallback);
});

Deno.test("a 1-day gap never collapses to zero hours", () => {
  assertEquals(throttleGapHours(1), 18);
});

Deno.test("held addresses match regardless of case and padding", () => {
  const rows = [{ email: "A@x.com" }, { email: " b@x.com " }, { email: "c@x.com" }];
  const { send, hold } = splitByThrottle(rows, new Set(["a@x.com", "b@x.com"]));
  assertEquals(hold.map((r) => r.email), ["A@x.com", " b@x.com "]);
  assertEquals(send.map((r) => r.email), ["c@x.com"]);
});

Deno.test("nothing held means everyone sends", () => {
  const rows = [{ email: "a@x.com" }];
  const { send, hold } = splitByThrottle(rows, new Set());
  assertEquals(send.length, 1);
  assertEquals(hold.length, 0);
});

Deno.test("throttleDays and throttleGapHours agree on the fallback", () => {
  assertEquals(throttleDays(null), DEFAULT_THROTTLE_DAYS);
  assertEquals(throttleDays(7), 7);
  assertEquals(throttleDays(0), 0);
  assertEquals(throttleDays(-1), 0);
});

Deno.test("every deadline-reminder label the drafter can emit is exempt", () => {
  for (const l of ["48h-promo", "24h-promo", "48h-reg-close", "24h-reg-close", "final-call"]) {
    assertEquals(isDeadlineReminderLabel(l), true, l);
  }
});

Deno.test("kickoff, mid-window, thanks and a missing label are NOT exempt", () => {
  for (const l of ["kickoff", "mid-window", "thanks", "", null, undefined, 5, "reminder-48h"]) {
    assertEquals(isDeadlineReminderLabel(l), false, String(l));
  }
});
