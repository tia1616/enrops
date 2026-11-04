// Pins the invitation email and the reminder timing (spec v3 H4).

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { inviteSubject, inviteOpening, renderInvite, reminderDue, parseEmails } from "./inviteEmail.ts";

const inv = { host_name: "Happy Valley Parks and Rec", inviter_name: "Kacy Cullen", business_name_as_typed: "Tenant Two Arts", message: null };

Deno.test("the spec's subject and opening, with the host's name", () => {
  assertEquals(inviteSubject(inv, "invite"), "Happy Valley Parks and Rec invites you to share your safety record");
  assertEquals(inviteSubject(inv, "reminder"), "Reminder: Happy Valley Parks and Rec invites you to share your safety record");
  assert(inviteOpening("X").startsWith("X uses enrops to see the status of every outside provider's insurance, agreements and screening in one place."));
  assert(inviteOpening("X").includes("never a background report"));
});

Deno.test("escaped, links to the invitation, no em dash", () => {
  const { html, text } = renderInvite({ logo_url: null, primary_color: "#1C004F", page_bg_color: "#fff" }, { ...inv, message: "<b>hi</b>" }, "https://x/invite/t", "invite");
  assert(!html.includes("<b>hi</b>"));
  assert(html.includes('href="https://x/invite/t"'));
  assert(!html.includes("—") && !text.includes("—"));
});

Deno.test("reminders on day 3 and day 7, once each", () => {
  const sent = "2026-11-01T12:00:00Z";
  assertEquals(reminderDue(sent, null, null, new Date("2026-11-03T12:00:00Z")), null);
  assertEquals(reminderDue(sent, null, null, new Date("2026-11-04T12:00:00Z")), 1);
  assertEquals(reminderDue(sent, "x", null, new Date("2026-11-05T12:00:00Z")), null);
  assertEquals(reminderDue(sent, "x", null, new Date("2026-11-08T12:00:00Z")), 2);
  assertEquals(reminderDue(sent, null, null, new Date("2026-11-08T12:00:00Z")), 2);
  assertEquals(reminderDue(sent, "x", "y", new Date("2026-11-20T12:00:00Z")), null);
});

Deno.test("emails: one per line or comma, de-duplicated, all must be valid", () => {
  assertEquals(parseEmails("A@x.org\nb@y.org, a@x.org"), ["a@x.org", "b@y.org"]);
  assertEquals(parseEmails("a@x.org\nnope"), null);
  assertEquals(parseEmails("  "), null);
});
