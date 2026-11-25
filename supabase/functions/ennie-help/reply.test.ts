import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { NO_ANSWER, shapeReply } from "./reply.ts";

Deno.test("an answer with a real section passes through with its link data", () => {
  const r = shapeReply({ answered: true, answer: " Go to Finances. ", sources: ["how-you-get-paid"] });
  assertEquals(r.answered, true);
  assertEquals(r.answer, "Go to Finances.");
  assertEquals(r.sources.map((s) => s.id), ["how-you-get-paid"]);
  assertEquals(typeof r.sources[0].title, "string");
});

Deno.test("an answer citing only made-up sections becomes the person offer", () => {
  const r = shapeReply({ answered: true, answer: "Click Payments > Checks.", sources: ["pay-by-check"] });
  assertEquals(r, { answered: false, answer: NO_ANSWER, sources: [] });
});

Deno.test("an answer citing nothing becomes the person offer", () => {
  assertEquals(shapeReply({ answered: true, answer: "Yes.", sources: [] }).answered, false);
});

Deno.test("answered false never shows the model's text", () => {
  const r = shapeReply({ answered: false, answer: "Probably yes", sources: ["fees"] });
  assertEquals(r.answer, NO_ANSWER);
  assertEquals(r.sources, []);
});

Deno.test("cited ids written as {#id} are tolerated, duplicates dropped, unknown ones dropped", () => {
  const r = shapeReply({ answered: true, answer: "x", sources: ["{#fees}", "fees", "nope"] });
  assertEquals(r.sources.map((s) => s.id), ["fees"]);
});

Deno.test("garbage in is the person offer, never a throw", () => {
  for (const raw of [null, undefined, "text", 3, { answered: "true", answer: "x", sources: ["fees"] }]) {
    assertEquals(shapeReply(raw).answered, false);
  }
});
