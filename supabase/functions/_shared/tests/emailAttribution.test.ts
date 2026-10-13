import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { sanitizeAttribution, withEmailAttribution } from "../emailAttribution.ts";

const SITE = "https://enrops.com";
const TAGS = { campaignId: "11111111-1111-1111-1111-111111111111", touchpointId: "22222222-2222-2222-2222-222222222222" };

Deno.test("our own register link gets the four tags", () => {
  const u = new URL(withEmailAttribution("https://enrops.com/j2s", SITE, TAGS));
  assertEquals(u.searchParams.get("utm_source"), "enrops_email");
  assertEquals(u.searchParams.get("utm_medium"), "email");
  assertEquals(u.searchParams.get("utm_campaign"), TAGS.campaignId);
  assertEquals(u.searchParams.get("utm_content"), TAGS.touchpointId);
});

Deno.test("an existing query string is kept (program deep link)", () => {
  const u = new URL(withEmailAttribution("https://enrops.com/j2s?program=abc", SITE, TAGS));
  assertEquals(u.searchParams.get("program"), "abc");
  assertEquals(u.searchParams.get("utm_medium"), "email");
});

Deno.test("someone else's site is returned untouched", () => {
  const url = "https://partner.example.org/register?x=1";
  assertEquals(withEmailAttribution(url, SITE, TAGS), url);
});

Deno.test("a look-alike host is not our site", () => {
  const url = "https://enrops.com.evil.test/j2s";
  assertEquals(withEmailAttribution(url, SITE, TAGS), url);
});

Deno.test("a hand-made tag on the link wins", () => {
  const u = new URL(withEmailAttribution("https://enrops.com/j2s?utm_source=newsletter", SITE, TAGS));
  assertEquals(u.searchParams.get("utm_source"), "newsletter");
});

Deno.test("garbage in, garbage out unchanged - never throws", () => {
  assertEquals(withEmailAttribution("not a url", SITE, TAGS), "not a url");
  assertEquals(withEmailAttribution("", SITE, TAGS), "");
});

Deno.test("sanitize keeps known short tags and drops the rest", () => {
  assertEquals(
    sanitizeAttribution({ utm_source: "enrops_email", utm_campaign: TAGS.campaignId, evil: "x", utm_term: "<b>" }),
    { utm_source: "enrops_email", utm_campaign: TAGS.campaignId },
  );
});

Deno.test("sanitize refuses non-objects, arrays, oversize values and empties", () => {
  assertEquals(sanitizeAttribution(null), null);
  assertEquals(sanitizeAttribution("utm_source=x"), null);
  assertEquals(sanitizeAttribution([{ utm_source: "x" }]), null);
  assertEquals(sanitizeAttribution({ utm_source: "a".repeat(101) }), null);
  assertEquals(sanitizeAttribution({}), null);
  assertEquals(sanitizeAttribution({ utm_source: 5 }), null);
});
