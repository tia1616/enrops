// Retry-on-429 for Resend calls.
//
// Resend's limit is 10 requests PER SECOND PER ACCOUNT - not per function
// invocation. Two campaigns scheduled for the same minute (an A/B pair always
// is) are two invocations drawing on one budget, so pacing inside a single
// invocation cannot keep the pair under it. On 2026-11-04 the "Early bird ends
// tonight" touchpoint of campaign A lost one whole batch of 100 that way: the
// 429 came back for the entire request and all 100 rows were logged `failed`.
//
// A 429 means Resend refused the request BEFORE processing it, so nothing in it
// was sent and retrying cannot duplicate mail. That is the only status retried
// here. A 5xx or a dropped connection is ambiguous (the batch may or may not
// have gone out) and re-sending it could mail a family twice, so those are
// deliberately left to fail as before.

export type RateLimitRetryOptions = {
  /** Retries after the first attempt (so up to maxRetries + 1 requests). */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Extra random wait (0..jitterMs) so two invocations that were 429ed
   *  together do not retry in the same instant and collide again. */
  jitterMs?: number;
  /** Epoch ms. A retry whose wait would end after this is not attempted, so a
   *  caller with a hard wall-clock budget is never slept past it. */
  deadlineAt?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
};

/** `Retry-After` as milliseconds, or null when absent or not a plain number of
 *  seconds (Resend sends whole seconds; an HTTP-date form is ignored and the
 *  backoff schedule is used instead). */
export function retryAfterMs(header: string | null | undefined): number | null {
  if (header == null) return null;
  const trimmed = header.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 1000);
}

/**
 * Runs `send()`, retrying while it answers 429. Returns the last response (a
 * 429 once retries or the deadline are used up) and how many retries happened,
 * so the caller can put that in the error it logs.
 */
export async function fetchWithRateLimitRetry(
  send: () => Promise<Response>,
  opts: RateLimitRetryOptions = {},
): Promise<{ res: Response; retries: number }> {
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 8000;
  const jitterMs = opts.jitterMs ?? 250;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;

  let retries = 0;
  for (;;) {
    const res = await send();
    if (res.status !== 429 || retries >= maxRetries) return { res, retries };

    // Honour the server's hint, but never wait LESS than our own backoff: a hint
    // of 0-1s straight after a burst has been seen to 429 again.
    const hinted = retryAfterMs(res.headers.get("retry-after")) ?? 0;
    const backoff = baseDelayMs * 2 ** retries;
    const wait = Math.min(maxDelayMs, Math.max(hinted, backoff)) + Math.floor(random() * jitterMs);
    if (opts.deadlineAt !== undefined && now() + wait > opts.deadlineAt) return { res, retries };

    // Release the connection of the response we are discarding.
    try { await res.body?.cancel(); } catch { /* already consumed */ }
    await sleep(wait);
    retries++;
  }
}
