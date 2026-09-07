// The "is this class actually happening" rule, pinned.
//
// This rule decides whether a session can become MONEY, so the cases that
// matter are the two that look alike and are not: 'cancelled' (does not meet,
// must never pay) and 'closed' (enrolment shut, STILL MEETS every week, must
// pay). An allow-list of 'open' alone would have looked correct in review and
// would have stopped paying every class in the back half of a term.
//
// The four statuses asserted here are the whole of programs_status_check, read
// back off BOTH databases on 2026-09-07:
//   CHECK (status = ANY (ARRAY['draft','open','closed','cancelled']))
// If that constraint gains a value, `classifyProgramStatus` returns 'unknown'
// and the callers diverge on purpose (seeder seeds + logs, money path refuses),
// which is what the last two tests hold in place.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  classifyProgramStatus,
  mayBecomePay,
  NOT_RUNNING_PROGRAM_STATUSES,
  RUNNING_PROGRAM_STATUSES,
} from "../programRunning.ts";

Deno.test("an open class is running and payable", () => {
  assertEquals(classifyProgramStatus("open"), "running");
  assertEquals(mayBecomePay(classifyProgramStatus("open")), true);
});

Deno.test("a CLOSED class still meets, so it stays payable", () => {
  // Enrolment shut is not the same as cancelled. The instructor portal renders
  // its card and its check-in; if the money path refused it, an instructor
  // would mark it taught and never be paid.
  assertEquals(classifyProgramStatus("closed"), "running");
  assertEquals(mayBecomePay(classifyProgramStatus("closed")), true);
});

Deno.test("a cancelled class is never payable — the bug this exists for", () => {
  assertEquals(classifyProgramStatus("cancelled"), "not_running");
  assertEquals(mayBecomePay(classifyProgramStatus("cancelled")), false);
});

Deno.test("a draft class is never payable", () => {
  assertEquals(classifyProgramStatus("draft"), "not_running");
  assertEquals(mayBecomePay(classifyProgramStatus("draft")), false);
});

Deno.test("every status in the DB constraint is classified — none fall through to unknown", () => {
  // The live CHECK, transcribed. A status that reached 'unknown' here would
  // mean the money path started refusing something real.
  for (const status of ["draft", "open", "closed", "cancelled"]) {
    const state = classifyProgramStatus(status);
    assertEquals(
      state === "running" || state === "not_running",
      true,
      `${status} classified as ${state}; it is in programs_status_check and must be decided`,
    );
  }
});

Deno.test("a status nobody has reasoned about is unknown, and unknown does not pay", () => {
  assertEquals(classifyProgramStatus("paused"), "unknown");
  assertEquals(mayBecomePay(classifyProgramStatus("paused")), false);
});

Deno.test("a missing status is unknown, not running", () => {
  assertEquals(classifyProgramStatus(null), "unknown");
  assertEquals(classifyProgramStatus(undefined), "unknown");
  assertEquals(mayBecomePay("missing"), false);
});

Deno.test("the two lists do not overlap", () => {
  const running = new Set<string>(RUNNING_PROGRAM_STATUSES);
  for (const s of NOT_RUNNING_PROGRAM_STATUSES) {
    assertEquals(running.has(s), false, `${s} is in both lists`);
  }
});
