// Pins the partner invite's words and who may add a note (20261125).
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { partnerPortalWhat, partnerNoteBlock, cleanPartnerNote } from "./partnerEmail.ts";

Deno.test("only the provider's own admin can add a note", () => {
  assertEquals(cleanPartnerNote("Hi Kacy!", true), "Hi Kacy!");
  assertEquals(cleanPartnerNote("Hi Kacy!", false), "", "a public sign-in request never carries a note");
  assertEquals(cleanPartnerNote(42, true), "");
  assertEquals(cleanPartnerNote("  a\r\nb  ", true), "a\nb");
  assertEquals(cleanPartnerNote("x".repeat(1500), true).length, 1000);
});

Deno.test("the note is escaped and keeps line breaks", () => {
  const html = partnerNoteBlock("Hi <b>Kacy</b>\nSee you Monday", "Journey to STEAM", "#5847C9");
  assert(html.includes("Hi &lt;b&gt;Kacy&lt;/b&gt;<br>See you Monday"));
  assert(html.includes("A note from Journey to STEAM"));
  assertEquals(partnerNoteBlock("", "X", "#000"), "");
});

Deno.test("the body says what the portal holds, no em dashes", () => {
  const one = partnerPortalWhat("Journey to STEAM", " for Happy Valley Parks and Rec", false);
  assert(one.startsWith("Journey to STEAM shares its work at your sites with you for Happy Valley Parks and Rec"));
  assert(one.includes("enrollment and roster") && one.includes("a summary when a class finishes") && one.includes("safety record"));
  const many = partnerPortalWhat("x", "", true);
  assert(many.startsWith("The providers you work with"));
  assert(!/[—–]/.test(one + many));
});
