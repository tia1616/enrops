// The send-log contract, pinned across the runtime boundary.
//
// formatSendError (Deno, _shared/sendLog.ts) writes the error string.
// isPermanentFailure (browser, src/lib/deliveryIssues.js) parses it, and its
// verdict is what makes delivery-alert-cron raise a failed send to the operator
// as "needs you" rather than leaving it to retry forever.
//
// Nothing compiles those two together: one is a Deno edge function, the other
// ships in the browser bundle, and they agree only on the shape of a string.
// That is bug class #30 exactly — a mismatch would pass the build, pass the
// type-check, pass every other test, and simply mean a family whose refund
// receipt bounced is never surfaced to anybody. So BOTH SIDES ARE IMPORTED FROM
// SOURCE here and asserted against each other; neither string is retyped.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { formatSendError, SEND_SOURCES } from "../sendLog.ts";
// The real browser-side classifier, not a copy of it.
import { isPermanentFailure } from "../../../../src/lib/deliveryIssues.js";

Deno.test("a permanent Resend refusal is written so the classifier calls it permanent", () => {
  // 422 = the real one on prod: an address stored with no domain.
  const msg = formatSendError(422, '{"message":"Invalid `to` field"}');
  assert(
    isPermanentFailure(msg),
    `classifier did not recognise ${JSON.stringify(msg)} as permanent — a bad ` +
      `address would never reach the operator`,
  );
});

Deno.test("transient failures stay transient, so the cron keeps retrying", () => {
  for (const status of [429, 500, 502, 503]) {
    const msg = formatSendError(status, "upstream hiccup");
    assertEquals(
      isPermanentFailure(msg),
      false,
      `Resend ${status} must not be treated as a bad address`,
    );
  }
});

Deno.test("every 4xx except 429 is permanent", () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert(isPermanentFailure(formatSendError(status, "x")), `${status} should be permanent`);
  }
});

Deno.test("a thrown (non-HTTP) failure is NOT claimed to be a bad address", () => {
  // No status code to parse. The honest answer is "we do not know", which means
  // transient — asserting "the email address looks invalid" off a network blip
  // would send an operator to edit a perfectly good address.
  const msg = formatSendError(undefined, "connection reset");
  assertEquals(isPermanentFailure(msg), false);
  assert(msg.includes("connection reset"), "the cause must survive into the log");
});

Deno.test("the error string never grows without bound", () => {
  // error_message goes in a row read by two panels and an email. A 40KB Resend
  // body would render into all three.
  const msg = formatSendError(500, "x".repeat(50_000));
  assert(msg.length < 600, `error message was ${msg.length} chars`);
});

Deno.test("every send source has an operator-facing name", () => {
  // The label is what stops a transactional row rendering as the bare fallback
  // "Automated email" on the timeline. A source added without one silently
  // reintroduces exactly the defect this work exists to remove.
  for (const [source, label] of Object.entries(SEND_SOURCES)) {
    assert(typeof label === "string" && label.trim().length > 0, `${source} has no label`);
    assert(
      label !== "Automated email" && label !== "Update",
      `${source} is labelled with the fallback it exists to replace`,
    );
  }
});

Deno.test("source keys are safe as a database dedupe discriminator", () => {
  // source is half of the unique index (organization_id, source, context_key).
  for (const source of Object.keys(SEND_SOURCES)) {
    assert(/^[a-z][a-z0-9_]*$/.test(source), `${source} is not a plain snake_case key`);
  }
});
