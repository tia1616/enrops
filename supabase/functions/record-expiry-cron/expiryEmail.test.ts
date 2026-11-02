// Pins the expiry email's words. When an item is due is the database's job
// (record_expiry_due, proven on staging against the real 1/17/2027 renewal).

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { itemLabel, whenText, subjectFor, linkFor, renderExpiryEmail, type DueItem } from "./expiryEmail.ts";

const cert: DueItem = {
  organization_id: "o", subject_type: "document", subject_id: "d1", doc_type: "insurance",
  title: "Certificate of liability insurance", partner_name: "Happy Valley Parks and Rec",
  instructor_name: null, expires_on: "2027-01-17", days_left: 30, tier: 30,
};
const check: DueItem = {
  ...cert, subject_type: "background_check", subject_id: "i1", doc_type: null, title: null,
  partner_name: null, instructor_name: "Riley Davis", expires_on: "2026-12-17", days_left: -2, tier: 0,
};

Deno.test("a certificate names its partner", () => {
  assertEquals(itemLabel(cert), "Insurance certificate for Happy Valley Parks and Rec");
});

Deno.test("a document with no partner and an unknown type falls back to its title", () => {
  assertEquals(itemLabel({ ...cert, doc_type: "other", title: "Food handler card", partner_name: null }), "Food handler card");
});

Deno.test("an instructor's check names the instructor", () => {
  assertEquals(itemLabel(check), "Riley Davis's background check");
});

Deno.test("the when-line for each tier", () => {
  assertEquals(whenText(cert), "expires in 30 days, on Jan 17, 2027");
  assertEquals(whenText({ ...cert, days_left: 1 }), "expires tomorrow");
  assertEquals(whenText({ ...cert, days_left: 0 }), "expires today");
  assertEquals(whenText(check), "expired Dec 17, 2026");
});

Deno.test("one item: the subject says exactly what and when", () => {
  assertEquals(subjectFor([cert]), "Insurance certificate for Happy Valley Parks and Rec expires in 30 days, on Jan 17, 2027");
});

Deno.test("several items: one email, counted", () => {
  assertEquals(subjectFor([cert, check]), "2 items on your safety record need renewing");
});

Deno.test("the button goes where the fix is", () => {
  assertEquals(linkFor([check], "https://x").href, "https://x/admin/instructors");
  assertEquals(linkFor([check, cert], "https://x"), { href: "https://x/admin/partner-documents", label: "Update your documents" });
});

Deno.test("names are escaped in the html and there is no em dash", () => {
  const brand = { org_name: "A&B", logo_url: null, primary_color: "#1C004F", page_bg_color: "#fff" };
  const { html, text } = renderExpiryEmail(brand, [{ ...check, instructor_name: "<b>Eve</b>" }], "https://x");
  assert(!html.includes("<b>Eve</b>"));
  assert(!html.includes("—") && !text.includes("—"));
});
