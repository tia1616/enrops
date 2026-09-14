// Pins when a school gets an updated roster, and - more importantly - when it
// does NOT. The failure mode that matters here is not a missing email, it is
// twenty schools emailed on one morning because a comparison defaulted the wrong
// way. Every "do not send" case below is a real state this will meet on prod.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { rosterStudentIds, rosterChanged, isStillRunning, shouldResendRoster } from "./rosterChange.ts";

// The real rule, imported rather than re-spelled - the same function the PDF
// filters with. If this rule ever changes, these tests change with it.
import { isOnRoster } from "../_shared/rosterOrder.ts";

const paid = (id: string) => ({ student: { id }, payment_status: "paid", status: "pending" });
const confirmed = (id: string) => ({ student: { id }, status: "confirmed", payment_status: null });
const achClearing = (id: string) => ({ student: { id }, ach_payment_state: "processing", status: "pending" });
const pendingUnpaid = (id: string) => ({ student: { id }, status: "pending", payment_status: "pending" });

// --- membership, via the shared rule ----------------------------------------
Deno.test("a paid child is on the roster", () => {
  assertEquals(rosterStudentIds([paid("b")], isOnRoster), ["b"]);
});

Deno.test("an abandoned checkout is NOT on the roster", () => {
  assertEquals(rosterStudentIds([pendingUnpaid("b")], isOnRoster), []);
});

Deno.test("a bank transfer still clearing holds its place", () => {
  assertEquals(rosterStudentIds([achClearing("b")], isOnRoster), ["b"]);
});

Deno.test("ids come back sorted, so re-ordering is not a change", () => {
  assertEquals(rosterStudentIds([paid("c"), paid("a"), paid("b")], isOnRoster), ["a", "b", "c"]);
});

Deno.test("two registrations for one child count once", () => {
  // Duplicate student rows are a known live defect; cleaning one up must not
  // read as a roster change and mail the school.
  assertEquals(rosterStudentIds([paid("a"), confirmed("a")], isOnRoster), ["a"]);
});

Deno.test("a registration with no student is skipped, not crashed on", () => {
  assertEquals(rosterStudentIds([{ student: null, payment_status: "paid" }, paid("a")], isOnRoster), ["a"]);
});

Deno.test("no registrations is an empty roster, not an error", () => {
  assertEquals(rosterStudentIds([], isOnRoster), []);
  assertEquals(rosterStudentIds(null, isOnRoster), []);
});

// --- the comparison ----------------------------------------------------------
Deno.test("a child added is a change", () => {
  assertEquals(rosterChanged(["a"], ["a", "b"]), true);
});

Deno.test("a child dropped is a change", () => {
  assertEquals(rosterChanged(["a", "b"], ["a"]), true);
});

Deno.test("a swap of equal size is still a change", () => {
  // Length alone would miss this: one child leaves and another joins the same day.
  assertEquals(rosterChanged(["a", "b"], ["a", "c"]), true);
});

Deno.test("the same roster is not a change", () => {
  assertEquals(rosterChanged(["a", "b"], ["a", "b"]), false);
});

Deno.test("NO BASELINE IS NOT A CHANGE - this is what stops a mass send on day one", () => {
  // Every roster sent before this shipped has a null fingerprint. If this
  // defaulted to true, the first cron run would email every school we have ever
  // sent a roster to, at once.
  assertEquals(rosterChanged(null, ["a", "b"]), false);
  assertEquals(rosterChanged(undefined, ["a"]), false);
});

Deno.test("emptying a roster entirely is still a change", () => {
  assertEquals(rosterChanged(["a"], []), true);
});

// --- the end of the class ----------------------------------------------------
Deno.test("a class whose last session is today is still running", () => {
  assertEquals(isStillRunning("2026-12-10", "2026-12-10"), true);
});

Deno.test("a class that finished yesterday is not", () => {
  assertEquals(isStillRunning("2026-12-09", "2026-12-10"), false);
});

Deno.test("a class with no resolvable dates goes quiet rather than mailing", () => {
  assertEquals(isStillRunning(null, "2026-12-10"), false);
  assertEquals(isStillRunning(undefined, "2026-12-10"), false);
});

// --- the whole decision ------------------------------------------------------
const base = {
  alreadySentToday: false,
  previousIds: ["a"],
  currentIds: ["a", "b"],
  lastSessionDate: "2026-12-10",
  today: "2026-09-14",
  hasRecipients: true,
};

Deno.test("the ordinary case: a child joined mid-term, so the school is told", () => {
  assertEquals(shouldResendRoster(base).send, true);
});

Deno.test("a roster already sent today is never sent twice - covers manual sends too", () => {
  const r = shouldResendRoster({ ...base, alreadySentToday: true });
  assertEquals(r.send, false);
  assertEquals(r.reason, "already sent today");
});

Deno.test("a school with nobody on file is skipped before anything else is computed", () => {
  assertEquals(shouldResendRoster({ ...base, hasRecipients: false }).send, false);
});

Deno.test("an unarmed class stays quiet", () => {
  const r = shouldResendRoster({ ...base, previousIds: null });
  assertEquals(r.send, false);
  assertEquals(r.reason, "no baseline yet");
});

Deno.test("a finished class is not mailed even though its roster changed", () => {
  // A refund processed in January must not mail a school about a class that
  // ended in December.
  const r = shouldResendRoster({ ...base, lastSessionDate: "2026-09-13" });
  assertEquals(r.send, false);
  assertEquals(r.reason, "class has finished");
});

Deno.test("an unchanged roster produces no email", () => {
  const r = shouldResendRoster({ ...base, currentIds: ["a"] });
  assertEquals(r.send, false);
  assertEquals(r.reason, "roster unchanged");
});

Deno.test("every refusal says why, so a quiet morning can be explained", () => {
  const reasons = [
    shouldResendRoster({ ...base, alreadySentToday: true }).reason,
    shouldResendRoster({ ...base, hasRecipients: false }).reason,
    shouldResendRoster({ ...base, previousIds: null }).reason,
    shouldResendRoster({ ...base, lastSessionDate: "2026-01-01" }).reason,
    shouldResendRoster({ ...base, currentIds: ["a"] }).reason,
  ];
  assertEquals(new Set(reasons).size, 5);   // no two refusals share a reason
});
