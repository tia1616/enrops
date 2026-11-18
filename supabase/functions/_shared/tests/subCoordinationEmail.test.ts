import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildSubCoordinationEmail } from "../subCoordinationEmail.ts";

const base = {
  regularFirst: "Maria", subFirst: "Dana", curriculumName: "LEGO Robotics",
  locationName: "Lincoln Elementary", friendlyDate: "Tuesday, December 1",
  portalUrl: "https://enrops.com/acme/instructor", coordinationNotes: "", signOff: "Journey to STEAM",
};

Deno.test("note keeps its line breaks in HTML and is escaped", () => {
  const { html, text } = buildSubCoordinationEmail({ ...base, coordinationNotes: "Please Reply All.\n<b>Call</b> if late." });
  assert(html.includes("Please Reply All.<br>&lt;b&gt;Call&lt;/b&gt; if late."));
  assert(text.includes("Please Reply All.\n<b>Call</b> if late."));
});

Deno.test("blank note adds no paragraph and no extra blank lines", () => {
  const { html, text } = buildSubCoordinationEmail({ ...base, coordinationNotes: "   " });
  assert(!text.includes("\n\n\n"));
  assertEquals((html.match(/<p /g) ?? []).length, 6);
});

Deno.test("sign-off and subject", () => {
  const { html, text, subject } = buildSubCoordinationEmail(base);
  assert(html.includes("— Journey to STEAM</p>"));
  assert(text.endsWith("— Journey to STEAM"));
  assertEquals(subject, "Coordinating December 1 — LEGO Robotics at Lincoln Elementary");
});
