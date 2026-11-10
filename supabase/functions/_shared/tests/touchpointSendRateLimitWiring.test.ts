// Pins the wiring the helper test cannot see: the batch sender must go through
// the 429 retry (a bare fetch quietly brings the 2026-11-04 failure back), and
// the resend allowlist may only NARROW the audience.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const SRC = Deno.readTextFileSync("supabase/functions/marketing-touchpoint-send/index.ts")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

Deno.test("sendBatchViaResend reaches Resend only through fetchWithRateLimitRetry", () => {
  const start = SRC.indexOf("async function sendBatchViaResend(");
  assert(start > 0, "sendBatchViaResend not found");
  const body = SRC.slice(start, SRC.indexOf("\n}\n", start));
  assert(body.includes("fetchWithRateLimitRetry("), "must call the retry helper");
  assert(body.includes("deadlineAt"), "must bound retries by the send budget");
  // The only fetch( inside it is the thunk handed to the helper.
  assert((body.match(/\bfetch\(/g) ?? []).length === 1, "exactly one fetch, inside the helper thunk");
});

Deno.test("the batch loop passes the send-budget deadline", () => {
  assert(SRC.includes("sendBatchViaResend(batchPayload, sendLoopStartedAt + SEND_TIME_BUDGET_MS)"));
});

Deno.test("the recipient list and the dedup set are both read through readAllPages", () => {
  // 2026-11-10: an unpaged rpc("get_campaign_recipients") was capped at 1,000
  // rows and 283 families were never mailed. The unpaged dedup read had the
  // same cap, so fixing only the first would have double-sent on a re-run.
  const rpcCalls = [...SRC.matchAll(/rpc\("get_campaign_recipients"/g)].length;
  assert(rpcCalls === 1, "exactly one recipient-list read");
  const rpcAt = SRC.indexOf('rpc("get_campaign_recipients"');
  const before = SRC.slice(Math.max(0, rpcAt - 400), rpcAt);
  assert(before.includes("readAllPages<Recipient>("), "the recipient rpc must sit inside readAllPages");
  assert(/rpc\("get_campaign_recipients", \{ p_campaign_id: campaign\.id \}\)\.order\("id"\)\.limit\(limit\)/.test(SRC),
    "recipient pages must be ordered by id and limited");
  const dedupAt = SRC.search(/\.eq\("touchpoint_id", touchpoint\.id\)\s*\.in\("status", DELIVERED_STATUSES\)/);
  assert(dedupAt > 0, "dedup read not found");
  const dedupBefore = SRC.slice(Math.max(0, dedupAt - 400), dedupAt);
  assert(dedupBefore.includes("readAllPages<{ id: string; recipient_id: string }>("), "dedup read must sit inside readAllPages");
  // No other unpaged read of DELIVERED rows for this touchpoint may come back.
  const deliveredReads = [...SRC.matchAll(/\.in\("status", DELIVERED_STATUSES\)/g)].length;
  assertEquals(deliveredReads, 1, "one delivered-rows read, the paged one");
});

Deno.test("only_recipient_ids only filters recipientRows - never adds to it", () => {
  const uses = [...SRC.matchAll(/only_recipient_ids/g)].length;
  assert(uses >= 4, "allowlist should be typed, validated, applied and reported");
  assert(
    /recipientRows = recipientRows\.filter\(\(r\) => allow\.has\(r\.id\)\)/.test(SRC),
    "allowlist must be applied as a filter on the already-eligible rows",
  );
  // Nothing may push the allowlist ids into the audience.
  assert(!/recipientRows\.push|recipientRows = \[\.\.\.recipientRows/.test(SRC));
  // Malformed allowlist refuses instead of falling back to the whole audience.
  assert(SRC.includes("only_recipient_ids must be a non-empty array"));
});
