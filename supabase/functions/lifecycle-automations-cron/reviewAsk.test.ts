import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  eveningDue, groupReviewFamilies, plusDays, reminderSubject, reviewAskContextKey,
  reviewReminderContextKey, reviewVariantFor, type ReviewCandidateRow,
} from "./reviewAsk.ts";

Deno.test("eveningDue: never before 6 pm on the day, then a 3-day grace", () => {
  assertEquals(eveningDue("2026-12-01", "2026-12-01", 7), false);   // the 7 am daily run
  assertEquals(eveningDue("2026-12-01", "2026-12-01", 17), false);
  assertEquals(eveningDue("2026-12-01", "2026-12-01", 18), true);
  assertEquals(eveningDue("2026-12-01", "2026-12-02", 7), true);    // missed evening, next morning
  assertEquals(eveningDue("2026-12-01", "2026-12-04", 7), true);
  assertEquals(eveningDue("2026-12-01", "2026-12-05", 19), false);  // past grace
  assertEquals(eveningDue("2026-12-02", "2026-12-01", 20), false);  // future
  assertEquals(eveningDue("2026-12-01", "2026-12-02", 8, 0), false); // camp day-1: same evening only
});

Deno.test("plusDays crosses month and year", () => {
  assertEquals(plusDays("2026-12-30", 3), "2027-01-02");
  assertEquals(plusDays("2026-12-01", -3), "2026-11-28");
});

Deno.test("reviewVariantFor: refunded only changes wording; never-enrolled is not asked", () => {
  assertEquals(reviewVariantFor("confirmed", "paid"), "standard");
  assertEquals(reviewVariantFor("confirmed", "unpaid"), "standard");   // installments / pay later
  assertEquals(reviewVariantFor("confirmed", "partial"), "standard");  // partially refunded, still enrolled
  assertEquals(reviewVariantFor("confirmed", "refunded"), "withdrawn");
  assertEquals(reviewVariantFor("cancelled", "paid"), "withdrawn");
  assertEquals(reviewVariantFor("cancelled", "partial"), "withdrawn");
  assertEquals(reviewVariantFor("cancelled", "refunded"), "withdrawn");
  assertEquals(reviewVariantFor("refunded", "refunded"), "withdrawn");
  assertEquals(reviewVariantFor("refunded", null), "withdrawn");
  assertEquals(reviewVariantFor("cancelled", "unpaid"), null);
  assertEquals(reviewVariantFor("pending", "unpaid"), null);
  assertEquals(reviewVariantFor("waitlist", "unpaid"), null);
});

Deno.test("context keys are per term and family, never per program", () => {
  assertEquals(reviewAskContextKey("FA26", " Ann@X.com "), "review_ask:FA26:ann@x.com");
  assertEquals(reviewReminderContextKey("FA26", "ann@x.com"), "review_reminder:FA26:ann@x.com");
});

const row = (o: Partial<ReviewCandidateRow>): ReviewCandidateRow => ({
  registration_id: "r1", program_id: "p1", program_name: "Robotics", term: "FA26",
  status: "confirmed", payment_status: "paid", parent_id: "pa1", parent_email: "ann@x.com",
  parent_first_name: "Ann", child_first_name: "Ava", target_date: "2026-12-01", ...o,
});

Deno.test("groupReviewFamilies: siblings share one ask; any active child = standard copy", () => {
  const fams = groupReviewFamilies([
    row({ registration_id: "r1", child_first_name: "Ava", status: "cancelled", payment_status: "refunded" }),
    row({ registration_id: "r2", child_first_name: "Liam" }),
  ], () => false);
  assertEquals(fams.length, 1);
  assertEquals(fams[0].variant, "standard");
  assertEquals(fams[0].child_first_names, ["Ava", "Liam"]);
  assertEquals(fams[0].registrations.map((r) => r.registration_id), ["r1", "r2"]);
});

Deno.test("groupReviewFamilies: all withdrawn = withdrawn copy; excluded and never-enrolled dropped", () => {
  const fams = groupReviewFamilies([
    row({ registration_id: "r1", status: "cancelled", payment_status: "paid" }),
    row({ registration_id: "r2", parent_email: "staff@x.com" }),
    row({ registration_id: "r3", parent_email: "p@x.com", status: "pending", payment_status: "unpaid" }),
  ], (k) => k === "staff@x.com");
  assertEquals(fams.map((f) => [f.key, f.variant]), [["ann@x.com", "withdrawn"]]);
});

Deno.test("groupReviewFamilies: a second program the same evening is not folded into the first ask", () => {
  const fams = groupReviewFamilies([
    row({ registration_id: "r1", program_id: "p1" }),
    row({ registration_id: "r2", program_id: "p2", program_name: "Lego" }),
  ], () => false);
  assertEquals(fams.length, 1);
  assertEquals(fams[0].program_name, "Robotics");
  assertEquals(fams[0].registrations.length, 1);
});

Deno.test("reminderSubject never doubles", () => {
  assertEquals(reminderSubject("Two minutes?"), "Following up: Two minutes?");
  assertEquals(reminderSubject("Following up: Two minutes?"), "Following up: Two minutes?");
});
