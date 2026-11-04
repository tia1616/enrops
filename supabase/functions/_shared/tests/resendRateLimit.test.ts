// A 429 from Resend must be retried (the whole request was refused, nothing
// sent), and nothing else may be: a 5xx or a dropped connection is ambiguous and
// re-sending could mail a family twice.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { fetchWithRateLimitRetry, retryAfterMs } from "../resendRateLimit.ts";

function scripted(statuses: Array<number | [number, Record<string, string>]>) {
  let calls = 0;
  const send = () => {
    const s = statuses[Math.min(calls, statuses.length - 1)];
    calls++;
    const [status, headers] = Array.isArray(s) ? s : [s, {}];
    const bodyText = status === 200 ? '{"data":[]}' : status === 429 ? '{"name":"rate_limit_exceeded","statusCode":429}' : '{"name":"x"}';
    return Promise.resolve(new Response(bodyText, { status, headers }));
  };
  return { send, calls: () => calls };
}
const noSleep = () => Promise.resolve();

Deno.test("429 then 200: retried once, the 200 is returned", async () => {
  const s = scripted([429, 200]);
  const waits: number[] = [];
  const { res, retries } = await fetchWithRateLimitRetry(s.send, {
    sleep: (ms) => { waits.push(ms); return Promise.resolve(); },
    random: () => 0,
  });
  assertEquals(res.status, 200);
  assertEquals(retries, 1);
  assertEquals(s.calls(), 2);
  assertEquals(waits, [500]);
});

Deno.test("Retry-After longer than our backoff wins; shorter does not shrink it", async () => {
  const long = scripted([[429, { "retry-after": "3" }], 200]);
  const w1: number[] = [];
  await fetchWithRateLimitRetry(long.send, { sleep: (ms) => { w1.push(ms); return Promise.resolve(); }, random: () => 0 });
  assertEquals(w1, [3000]);

  const short = scripted([[429, { "retry-after": "0" }], 200]);
  const w2: number[] = [];
  await fetchWithRateLimitRetry(short.send, { sleep: (ms) => { w2.push(ms); return Promise.resolve(); }, random: () => 0 });
  assertEquals(w2, [500]);
});

Deno.test("backoff doubles and is capped", async () => {
  const s = scripted([429, 429, 429, 429, 429, 200]);
  const waits: number[] = [];
  const { retries } = await fetchWithRateLimitRetry(s.send, {
    maxRetries: 5,
    maxDelayMs: 2000,
    sleep: (ms) => { waits.push(ms); return Promise.resolve(); },
    random: () => 0,
  });
  assertEquals(waits, [500, 1000, 2000, 2000, 2000]);
  assertEquals(retries, 5);
});

Deno.test("gives up after maxRetries and returns the 429 for the caller to log", async () => {
  const s = scripted([429]);
  const { res, retries } = await fetchWithRateLimitRetry(s.send, { maxRetries: 2, sleep: noSleep, random: () => 0 });
  assertEquals(res.status, 429);
  assertEquals(retries, 2);
  assertEquals(s.calls(), 3); // first try + 2 retries, never more
});

Deno.test("NEVER retries a 5xx, a 4xx, or a success - re-sending could mail a family twice", async () => {
  for (const status of [200, 400, 401, 422, 500, 502, 503]) {
    const s = scripted([status]);
    const { res, retries } = await fetchWithRateLimitRetry(s.send, { sleep: noSleep });
    assertEquals(res.status, status);
    assertEquals(retries, 0);
    assertEquals(s.calls(), 1, `status ${status} must be sent exactly once`);
  }
});

Deno.test("a 429 that is a QUOTA error (not the per-second limit) fails fast, unretried", async () => {
  for (const body of ['{"name":"daily_quota_exceeded","statusCode":429}', "", "not json"]) {
    let calls = 0;
    const send = () => { calls++; return Promise.resolve(new Response(body, { status: 429 })); };
    const { res, retries } = await fetchWithRateLimitRetry(send, { sleep: noSleep });
    assertEquals(res.status, 429);
    assertEquals(retries, 0);
    assertEquals(calls, 1, `body ${JSON.stringify(body)} must not be retried`);
    assertEquals(await res.text(), body); // caller can still read the original body
  }
});

Deno.test("a retried-out 429 still has a readable body for the caller's error", async () => {
  const { res } = await fetchWithRateLimitRetry(scripted([429]).send, { maxRetries: 1, sleep: noSleep, random: () => 0 });
  assert((await res.text()).includes("rate_limit_exceeded"));
});

Deno.test("a retry that would run past the deadline is not attempted", async () => {
  const s = scripted([429]);
  let t = 1_000;
  const { res, retries } = await fetchWithRateLimitRetry(s.send, {
    deadlineAt: 1_400, // first wait is 500ms -> 1_500 > 1_400
    now: () => t,
    sleep: (ms) => { t += ms; return Promise.resolve(); },
    random: () => 0,
  });
  assertEquals(res.status, 429);
  assertEquals(retries, 0);
  assertEquals(s.calls(), 1);
});

Deno.test("jitter is added on top, bounded by jitterMs", async () => {
  const s = scripted([429, 200]);
  const waits: number[] = [];
  await fetchWithRateLimitRetry(s.send, {
    jitterMs: 200,
    sleep: (ms) => { waits.push(ms); return Promise.resolve(); },
    random: () => 0.999,
  });
  assert(waits[0] >= 500 && waits[0] < 700, `wait ${waits[0]} should be 500 + <200 jitter`);
});

Deno.test("retryAfterMs reads whole/fractional seconds and ignores anything else", () => {
  assertEquals(retryAfterMs("2"), 2000);
  assertEquals(retryAfterMs("0.5"), 500);
  assertEquals(retryAfterMs(null), null);
  assertEquals(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT"), null);
  assertEquals(retryAfterMs(""), null);
});
