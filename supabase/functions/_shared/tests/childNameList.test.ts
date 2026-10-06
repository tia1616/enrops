// formatChildNameList is the one place both marketing-touchpoint-send
// ({{child_first_name}}) and lifecycle-automations-cron's review_request
// resolver turn "which children matched this registration scope" into a
// sentence. See 20261006d_campaign_child_name_resolver.sql for why this
// exists: the SU26 "Summer 2026 review catch-up" send quoted a stale or
// placeholder child name for multi-child families because the old
// denormalized marketing_recipients.child_first_name only ever held ONE name.

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { formatChildNameList } from "../childNameList.ts";

Deno.test("empty input renders as empty string, not a crash", () => {
  assertEquals(formatChildNameList([]), "");
  assertEquals(formatChildNameList([null, undefined, "", "   "]), "");
});

Deno.test("one name renders bare", () => {
  assertEquals(formatChildNameList(["Ava"]), "Ava");
});

Deno.test("two names join with 'and', no oxford comma", () => {
  assertEquals(formatChildNameList(["Ava", "Liam"]), "Ava and Liam");
});

Deno.test("three or more names use a serial comma before 'and'", () => {
  assertEquals(formatChildNameList(["Ava", "Liam", "Noah"]), "Ava, Liam, and Noah");
});

Deno.test("trims whitespace and drops blanks mixed in with real names", () => {
  assertEquals(formatChildNameList([" Ava ", "", null, "Liam"]), "Ava and Liam");
});

Deno.test("de-dupes case-insensitively — the same child on two matching registrations reads once", () => {
  assertEquals(formatChildNameList(["Ava", "ava", " Ava "]), "Ava");
});
