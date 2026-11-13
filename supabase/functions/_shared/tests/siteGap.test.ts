// _shared/siteGap.ts - the cross-site travel rule match-afterschool applies (20261113a).
//
// THE BUG THIS PINS. WI27 on prod: the matcher put one instructor at Atfalati
// Ridge 1:35-2:35 PM and Alameda Elementary 2:35-3:35 PM the same Wednesday,
// because "touching times do not overlap" was the only same-day rule. Same-site
// back-to-back must stay legal (OES runs 2:00-3:25 and 3:25-4:25 with one person).
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { clashesWithSiteGap } from "../siteGap.ts";

const t = (h: number, m = 0) => h * 60 + m;

Deno.test("different sites, touching times, 30 min rule -> clash (the WI27 pair)", () => {
  assertEquals(clashesWithSiteGap(
    { start: t(14, 35), end: t(15, 35), locationId: "alameda" },
    { start: t(13, 35), end: t(14, 35), locationId: "atfalati" }, 30), true);
});

Deno.test("same site, touching times -> no clash (OES back-to-back)", () => {
  assertEquals(clashesWithSiteGap(
    { start: t(15, 25), end: t(16, 25), locationId: "oes" },
    { start: t(14, 0), end: t(15, 25), locationId: "oes" }, 30), false);
});

Deno.test("different sites, gap exactly the minimum -> no clash", () => {
  assertEquals(clashesWithSiteGap(
    { start: t(15, 5), end: t(16, 5), locationId: "b" },
    { start: t(14, 0), end: t(14, 35), locationId: "a" }, 30), false);
});

Deno.test("different sites, one minute short of the minimum -> clash, either order", () => {
  const a = { start: t(15, 4), end: t(16, 4), locationId: "b" };
  const b = { start: t(14, 0), end: t(14, 35), locationId: "a" };
  assertEquals(clashesWithSiteGap(a, b, 30), true);
  assertEquals(clashesWithSiteGap(b, a, 30), true);
});

Deno.test("rule off (0) -> different sites behave like plain overlap", () => {
  assertEquals(clashesWithSiteGap(
    { start: t(14, 35), end: t(15, 35), locationId: "a" },
    { start: t(13, 35), end: t(14, 35), locationId: "b" }, 0), false);
});

Deno.test("a side with no site counts as a different site", () => {
  assertEquals(clashesWithSiteGap(
    { start: t(14, 35), end: t(15, 35), locationId: null },
    { start: t(13, 35), end: t(14, 35), locationId: null }, 30), true);
});

Deno.test("real overlap at the same site still clashes", () => {
  assertEquals(clashesWithSiteGap(
    { start: t(14, 0), end: t(15, 0), locationId: "a" },
    { start: t(14, 30), end: t(15, 30), locationId: "a" }, 30), true);
});

Deno.test("hours apart at different sites -> no clash (Grass Valley 12:15 / OES 3:25)", () => {
  assertEquals(clashesWithSiteGap(
    { start: t(15, 25), end: t(16, 25), locationId: "oes" },
    { start: t(12, 15), end: t(13, 15), locationId: "grass" }, 30), false);
});
