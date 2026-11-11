// Read EVERY row of a PostgREST query, however many there are.
//
// Why this exists: PostgREST silently caps a read (Supabase "Max rows", 1000 by
// default) and returns the first N rows with no error. On 2026-11-10 the
// marketing send loaded its recipients with one unpaged
// rpc("get_campaign_recipients") call, got the first 1,000 of 1,286 eligible
// families, mailed them, and marked the touchpoint 'sent'. 283 families got
// nothing and nobody was told.
//
// How it pages, and why not by offset:
// - KEYSET, not offset. Each page asks for rows with id > the last id seen,
//   ordered by id. get_campaign_recipients is re-run for every page and a
//   family can register (and drop out) between pages; with OFFSET that shifts
//   every later row down by one and silently skips someone. Keyset cannot skip:
//   it always resumes after the last row it actually has.
// - Stops only on an EMPTY page, never on "fewer rows than I asked for". If the
//   server's cap is ever set below the page size, a short page is just the cap
//   talking, and stopping there would bring the same silent truncation back.
//   The cost is one extra empty request per read.
// - A hard page ceiling turns a runaway loop (a query that keeps returning the
//   same rows) into a loud error instead of a hung function.
//
// Fails CLOSED: any page error returns { error } and no rows, so a caller can
// refuse to send rather than send to a partial list.

export type PageResult<T> = { data: T[] | null; error: { message: string } | null };

/**
 * @param fetchPage  builds ONE page: rows ordered by the key ascending, strictly
 *                   after `afterKey` when it is not null, at most `limit` rows.
 * @param keyOf      the row's unique, ordered key (the column the page is ordered by).
 * @param pageSize   rows to ask for per page (PostgREST's default cap is 1000).
 * @param maxPages   safety ceiling; exceeding it is an error, not a partial result.
 */
export async function readAllPages<T>(
  fetchPage: (afterKey: string | null, limit: number) => PromiseLike<PageResult<T>>,
  keyOf: (row: T) => string,
  pageSize = 1000,
  maxPages = 1000,
): Promise<{ rows: T[]; error: string | null }> {
  if (!Number.isInteger(pageSize) || pageSize < 1) return { rows: [], error: `invalid page size ${pageSize}` };
  const rows: T[] = [];
  let afterKey: string | null = null;
  // maxPages counts pages WITH rows; the closing empty page is always allowed.
  for (let page = 0; page <= maxPages; page++) {
    const { data, error } = await fetchPage(afterKey, pageSize);
    // Any error OBJECT fails closed. postgrest-js hands back {message: ""} for a
    // non-2xx with an empty body, so never let the caller test message text.
    if (error) return { rows: [], error: error.message || `page read failed: ${safeJson(error)}` };
    // A real empty page is []. null (an empty 2xx/404 body) is not "the end".
    if (!Array.isArray(data)) return { rows: [], error: "page read returned no data" };
    if (data.length === 0) return { rows, error: null };
    if (page === maxPages) break;
    // Every key must rise, from afterKey through the last row of the page. This
    // catches a query that dropped its ORDER BY (keyset would skip rows) or
    // ignores the after-key filter (it would loop or duplicate).
    let prev = afterKey;
    for (const row of data) {
      const k = keyOf(row);
      if (typeof k !== "string" || (prev !== null && !(k > prev))) {
        return { rows: [], error: `paging out of order at ${String(k)} (after ${prev})` };
      }
      prev = k;
    }
    rows.push(...data);
    afterKey = prev;
  }
  return { rows: [], error: `more than ${maxPages} pages of ${pageSize} rows` };
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Page size for marketing reads. Always 1000 except on STAGING, where an
 *  override lets ~100 synthetic recipients prove a multi-page send. Never honored
 *  elsewhere: each page re-runs get_campaign_recipients in full (~0.9 s for 1,095
 *  rows, EXPLAIN ANALYZE on prod 2026-11-10), so size 3 on a 1,095 list is ~366
 *  calls and the 150 s wall clock kills the send before anyone is mailed.
 *  Callers read the env at CALL time: a warm isolate keeps a module-scope value
 *  after the secret changes. */
export function marketingReadPageSize(raw: string | undefined | null, isStaging: boolean): number {
  if (!isStaging) return 1000;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 1000;
}
