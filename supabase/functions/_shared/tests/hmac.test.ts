// hmacBase64Url is the ONE signing primitive shared by marketing-unsubscribe,
// review-rate, and lifecycle-automations-cron's review-link minting — see
// _shared/hmac.ts for why three independent copies of this used to exist.
// The one property every caller depends on: the SAME secret+message always
// produces the SAME token, and a DIFFERENT message (even by one character,
// e.g. a different score) produces a token that does not verify against it.

import { assertEquals, assertNotEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { hmacBase64Url, constantTimeEquals } from "../hmac.ts";

Deno.test("same secret + message always produces the same token", async () => {
  const a = await hmacBase64Url("secret-1", "reg-1:org-1:5");
  const b = await hmacBase64Url("secret-1", "reg-1:org-1:5");
  assertEquals(a, b);
});

Deno.test("a different message produces a different token (score is bound in)", async () => {
  const forScore5 = await hmacBase64Url("secret-1", "reg-1:org-1:5");
  const forScore1 = await hmacBase64Url("secret-1", "reg-1:org-1:1");
  assertNotEquals(forScore5, forScore1);
});

Deno.test("a different secret produces a different token for the same message", async () => {
  const a = await hmacBase64Url("secret-1", "reg-1:org-1:5");
  const b = await hmacBase64Url("secret-2", "reg-1:org-1:5");
  assertNotEquals(a, b);
});

Deno.test("output is base64url — no +, /, or = padding characters", async () => {
  // Run a handful of messages; base64url encoding issues only show up for
  // specific byte patterns, so one sample isn't enough to catch a regression.
  for (const msg of ["a", "reg-1:org-1:3", "x".repeat(50), ""]) {
    const token = await hmacBase64Url("some-secret", msg);
    if (/[+/=]/.test(token)) {
      throw new Error(`token for "${msg}" contains a non-base64url character: ${token}`);
    }
  }
});

Deno.test("constantTimeEquals matches equal strings and rejects unequal ones", () => {
  assertEquals(constantTimeEquals("abc", "abc"), true);
  assertEquals(constantTimeEquals("abc", "abd"), false);
  assertEquals(constantTimeEquals("abc", "ab"), false);
  assertEquals(constantTimeEquals("", ""), true);
});
