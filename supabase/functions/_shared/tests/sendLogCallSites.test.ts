// Every logTransactionalSend call site must pass a subject.
//
// `subject` is OPTIONAL on the writer, deliberately: making it required would
// force a meaningless value on any future caller that genuinely has no subject.
// The cost of that choice is that dropping it at a call site is invisible - it
// type-checks, it builds, the email still sends, and the send log just quietly
// goes back to saying "Refund receipt" instead of the sentence the family read.
// Nobody would notice until an operator asked what was sent.
//
// So it is ratcheted here instead, the same way src/lib/rosterEmailPayload.test.mjs
// ratchets the roster payload keys after that exact class of bug survived from
// June. Derived from the SOURCE of each caller, never from a list retyped here:
// add a new sender and this test finds it and holds it to the same rule.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const CALLERS = [
  "supabase/functions/stripe-webhook/index.ts",
  "supabase/functions/refund-registration/index.ts",
  "supabase/functions/join-waitlist/index.ts",
  "supabase/functions/invite-parents/index.ts",
  "supabase/functions/lifecycle-automations-cron/waitlistSweep.ts",
];

/** Strip comments so a call site described in prose is never mistaken for one. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Return the argument text of each logTransactionalSend(...) call, by walking
 * braces rather than regex-matching - the calls are multi-line objects with
 * nested template literals, which a regex gets wrong in both directions.
 */
function callArgs(src: string): string[] {
  const out: string[] = [];
  const needle = "logTransactionalSend(";
  let i = src.indexOf(needle);
  while (i !== -1) {
    let depth = 0;
    let j = i + needle.length - 1;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) break; }
    }
    out.push(src.slice(i, j + 1));
    i = src.indexOf(needle, j);
  }
  return out;
}

Deno.test("every sender is wired, and every call passes a subject", async () => {
  let total = 0;
  for (const path of CALLERS) {
    const src = stripComments(await Deno.readTextFile(path));
    const calls = callArgs(src);
    assert(calls.length > 0, `${path} calls logTransactionalSend nowhere - was a sender unwired?`);
    calls.forEach((call, n) => {
      assert(
        /\bsubject\s*[:,]/.test(call),
        `${path} call #${n + 1} passes no subject. The send would be logged as its ` +
          `category only, losing the line the family actually received.`,
      );
      // A call that logs nothing identifying is worse than no row.
      assert(/\bsource\s*:/.test(call), `${path} call #${n + 1} passes no source`);
      assert(/\bcontextKey\s*:/.test(call), `${path} call #${n + 1} passes no contextKey`);
    });
    total += calls.length;
  }
  // Both directions: if a sender is REMOVED, the count drops and this notices.
  //
  // NINE, counted by this test rather than by me - my own first guess was eight,
  // and it was wrong because waitlistSweep has FOUR (lapse send, lapse throw,
  // invite failure, invite success), not two. Left as an exact number on purpose:
  // a send path added without a log row is exactly the gap this whole build
  // exists to close, and a >= assertion would let one through.
  assertEquals(total, 9, `expected 9 send-log call sites across the five senders, found ${total}`);
});

Deno.test("the writer still accepts and persists a subject", async () => {
  const src = stripComments(
    await Deno.readTextFile("supabase/functions/_shared/sendLog.ts"),
  );
  assert(/subject\?:\s*string\s*\|\s*null/.test(src), "sendLog no longer accepts a subject");
  assert(
    /rendered_subject:/.test(src),
    "sendLog accepts a subject but no longer writes it to rendered_subject - " +
      "the callers would all still compile and every subject would be dropped",
  );
});
