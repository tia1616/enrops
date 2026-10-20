import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { sendableEmail } from "../sendableEmail.ts";

Deno.test("an ordinary address is sendable, trimmed", () => {
  assertEquals(sendableEmail("parent@example.com"), "parent@example.com");
  assertEquals(sendableEmail("  first.last+tag@mail.example.co.uk "), "first.last+tag@mail.example.co.uk");
  assertEquals(sendableEmail("o'brien@example.com"), "o'brien@example.com");
});

Deno.test("two addresses in one field are not sendable (the 2026-10-20 case)", () => {
  assertEquals(sendableEmail("a@example.com; b@example.com"), null);
  assertEquals(sendableEmail("a@example.com, b@example.com"), null);
  assertEquals(sendableEmail("a@example.com b@example.com"), null);
});

Deno.test("structurally broken addresses are not sendable", () => {
  assertEquals(sendableEmail("isla.van wickle.123@import.local"), null);
  assertEquals(sendableEmail("no-at-sign.example.com"), null);
  assertEquals(sendableEmail("a@@example.com"), null);
  assertEquals(sendableEmail("a@example"), null);
  assertEquals(sendableEmail("a@example."), null);
  assertEquals(sendableEmail("Name <a@example.com>"), null);
});

Deno.test("empty and missing are null", () => {
  assertEquals(sendableEmail(""), null);
  assertEquals(sendableEmail("   "), null);
  assertEquals(sendableEmail(null), null);
  assertEquals(sendableEmail(undefined), null);
});
