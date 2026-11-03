// Pins the Monday digest's words. Who gets what is the database's job
// (partner_digest_due, proven on staging as the Happy Valley admin).

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { lineFor, subjectFor, byProvider, renderDigest, type DigestRow } from "./digestEmail.ts";

const base: DigestRow = {
  access_id: "a", partner_id: "p", partner_name: "Happy Valley Parks and Rec", to_email: "k@x.org",
  week_of: "2026-12-21", provider_name: "Journey to STEAM", kind: "expiring",
  label: "Insurance certificate", item_date: "2027-01-17",
};

Deno.test("each kind of line", () => {
  assertEquals(lineFor(base), "Insurance certificate expires Jan 17, 2027");
  assertEquals(lineFor({ ...base, item_date: "2026-12-21" }), "Insurance certificate expires today");
  assertEquals(lineFor({ ...base, kind: "expired", item_date: "2026-12-18" }), "Insurance certificate expired Dec 18, 2026");
  assertEquals(lineFor({ ...base, kind: "stopped_sharing", label: "Riley Davis" }), "Riley Davis stopped sharing their status with you");
});

Deno.test("the spec's subject, counting only expiring and expired", () => {
  const rows = [base, { ...base, kind: "expired" as const }, { ...base, kind: "stopped_sharing" as const, label: "Riley Davis" }];
  assertEquals(subjectFor(rows), "Your providers this week: 1 expiring, 1 expired");
});

Deno.test("grouped by provider, in name order", () => {
  const rows = [{ ...base, provider_name: "Zed Arts" }, base];
  assertEquals(byProvider(rows).map(([p]) => p), ["Journey to STEAM", "Zed Arts"]);
});

Deno.test("escaped, links to the partner home, no em dash", () => {
  const brand = { org_name: "enrops", logo_url: null, primary_color: "#1C004F", page_bg_color: "#fff" };
  const { html, text } = renderDigest(brand, [{ ...base, provider_name: "<b>X</b>" }], "https://x");
  assert(!html.includes("<b>X</b>"));
  assert(html.includes('href="https://x/partner"'));
  assert(!html.includes("—") && !text.includes("—"));
});
