// Unit tests for the abandoned-registration "Finish registering →" link.
// Run: deno test abandonedResumeUrl.test.ts
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { abandonedResumeUrl } from "./abandonedResumeUrl.ts";

const SITE = "https://enrops.com";

// Real prod values, 2026-09-09: the Irvington class an abandoned checkout on
// 2026-09-08 was for, and the org that sent the email.
const IRVINGTON_MINECRAFT = "24cdc69d-8607-43da-a18c-e2208f7efda6";

Deno.test("a program abandonment deep-links to that class", () => {
  assertEquals(
    abandonedResumeUrl(SITE, "j2s", { programs: { id: IRVINGTON_MINECRAFT } }),
    `https://enrops.com/j2s/register?program=${IRVINGTON_MINECRAFT}`,
  );
});

Deno.test("THE BUG: the link must carry ?program=, or Register.jsx bounces it to the catalog", () => {
  const url = abandonedResumeUrl(SITE, "j2s", { programs: { id: IRVINGTON_MINECRAFT } });
  // The old link was /register?resume_reg=<row id>. Register.jsx redirects any
  // visit without ?program= straight home, so this is the whole fix.
  assertEquals(url.includes("?program="), true);
  assertEquals(url.includes("resume_reg"), false);
});

Deno.test("the slug is never hardcoded - a second tenant gets its own page", () => {
  assertEquals(
    abandonedResumeUrl(SITE, "ukulele-project", { programs: { id: IRVINGTON_MINECRAFT } }),
    `https://enrops.com/ukulele-project/register?program=${IRVINGTON_MINECRAFT}`,
  );
});

// ── Camps: the wizard has no camp branch, so a deep link would be a dead end ──
Deno.test("a camp abandonment falls back to the catalog, NOT ?program=<camp id>", () => {
  assertEquals(
    abandonedResumeUrl(SITE, "j2s", { camp_sessions: { id: "8f0e1c22-aaaa-4bbb-8ccc-000000000001" } }),
    "https://enrops.com/j2s",
  );
});

// ── Fail safe, never fail broken ────────────────────────────────────────────
// Every one of these previously produced a URL that looked valid and was not.
Deno.test("a row with neither offering still yields a usable page", () => {
  assertEquals(abandonedResumeUrl(SITE, "j2s", {}), "https://enrops.com/j2s");
});

Deno.test("null and undefined rows do not crash the whole cron tick", () => {
  assertEquals(abandonedResumeUrl(SITE, "j2s", null), "https://enrops.com/j2s");
  assertEquals(abandonedResumeUrl(SITE, "j2s", undefined), "https://enrops.com/j2s");
});

Deno.test("a null programs object is not mistaken for a program", () => {
  assertEquals(
    abandonedResumeUrl(SITE, "j2s", { programs: null, camp_sessions: { id: "x" } }),
    "https://enrops.com/j2s",
  );
});

Deno.test("a non-string id never reaches the URL as [object Object] or undefined", () => {
  // PostgREST returns whatever the row holds. Interpolating an object or a
  // missing value produces a link that resolves to a class that does not exist,
  // which reads to the family as "the class is gone" rather than "we broke it".
  for (const bad of [undefined, null, 42, {}, [], ""]) {
    const url = abandonedResumeUrl(SITE, "j2s", { programs: { id: bad } });
    assertEquals(url, "https://enrops.com/j2s", `bad id ${JSON.stringify(bad)} leaked into the URL`);
    assertEquals(url.includes("[object"), false);
    assertEquals(url.includes("undefined"), false);
  }
});
