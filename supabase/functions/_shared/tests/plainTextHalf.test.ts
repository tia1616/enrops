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

Deno.test("register button div does not weld onto the next paragraph", () => {
  const h = `<p>Hi Ana,</p><p>Classes start.</p><div style="x"><a href="https://x.test/r">Register now &rarr;</a></div><p>- Jess</p>`;
  const out = chooseBodyText("Hi Ana, Classes start. Register now - Jess", h, id);
  assertStringIncludes(out, "Register now -> (https://x.test/r)\n");
  assertEquals(out.includes(")- Jess"), false);
});

Deno.test("a one-paragraph email with a link still gets its URL", () => {
  const out = chooseBodyText("Register at this link", `<p>Register at <a href="https://x.test/r">this link</a></p>`, id);
  assertStringIncludes(out, "this link (https://x.test/r)");
});

Deno.test("a genuinely one-line email keeps its stored text", () => {
  assertEquals(chooseBodyText("Just one line", "<p>Just one line</p>", id), "Just one line");
});
