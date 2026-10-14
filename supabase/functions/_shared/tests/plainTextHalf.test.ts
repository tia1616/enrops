import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { chooseBodyText } from "../plainTextHalf.ts";

const html = `<p>Hi Ana,</p><p>Classes start in January.</p><p><a href="https://x.test/r?a=1">Register now</a></p>`;
const id = (t: string) => t;

Deno.test("flattened stored text (old editor output) is replaced by text derived from the HTML", () => {
  const out = chooseBodyText("Hi Ana, Classes start in January. Register now", html, id);
  assertStringIncludes(out, "Hi Ana,\n\nClasses start in January.");
  assertStringIncludes(out, "Register now (https://x.test/r?a=1)");
});

Deno.test("hand-written stored text with line breaks is kept", () => {
  assertEquals(chooseBodyText("Hi Ana,\n\nSee you.", html, (t) => `R:${t}`), "R:Hi Ana,\n\nSee you.");
});

Deno.test("missing stored text falls back to the derived text", () => {
  assertStringIncludes(chooseBodyText(null, html, id), "Classes start in January.");
});

Deno.test("a genuinely one-line email keeps its stored text", () => {
  assertEquals(chooseBodyText("Just one line", "<p>Just one line</p>", id), "Just one line");
});
