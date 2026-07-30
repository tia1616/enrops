import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { listUnsubscribeHeaders } from "../listUnsubscribe.ts";

// Shape-accurate but tenant-neutral: the org id is a placeholder, not any real
// tenant's, so nobody greps this file and mistakes a fixture for live config.
const REAL_URL =
  "https://abc.supabase.co/functions/v1/marketing-unsubscribe?email=a%40b.com&org=00000000-0000-4000-a000-000000000001&t=Zm9vYmFy";

Deno.test("promotional send gets both headers, URI in angle brackets", () => {
  const h = listUnsubscribeHeaders(REAL_URL);
  assertEquals(h["List-Unsubscribe"], `<${REAL_URL}>`);
  assertEquals(h["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

// The whole safety story for transactional email: informational templates pass
// "" and MUST come out byte-for-byte unchanged. If this ever returns headers, a
// family can one-click out of their camp drop-off details.
Deno.test("transactional send gets nothing", () => {
  assertEquals(listUnsubscribeHeaders(""), {});
  assertEquals(listUnsubscribeHeaders("   "), {});
  assertEquals(listUnsubscribeHeaders(null), {});
  assertEquals(listUnsubscribeHeaders(undefined), {});
});

Deno.test("header injection is refused, not sanitized", () => {
  assertEquals(listUnsubscribeHeaders("https://x.co/u\r\nBcc: evil@x.co"), {});
  assertEquals(listUnsubscribeHeaders("https://x.co/u\nX-Foo: bar"), {});
  assertEquals(listUnsubscribeHeaders("https://x.co/u\tmore"), {});
});

Deno.test("non-https is refused", () => {
  assertEquals(listUnsubscribeHeaders("http://x.co/u"), {});
  assertEquals(listUnsubscribeHeaders("javascript:alert(1)"), {});
  assertEquals(listUnsubscribeHeaders("mailto:unsub@x.co"), {});
});

Deno.test("angle brackets in the URL would break the header, so refuse", () => {
  assertEquals(listUnsubscribeHeaders("https://x.co/u?a=<b>"), {});
});

Deno.test("surrounding whitespace is trimmed, not rejected", () => {
  const h = listUnsubscribeHeaders(`  ${REAL_URL}  `);
  assertEquals(h["List-Unsubscribe"], `<${REAL_URL}>`);
});
