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
  for (let page = 0; page < maxPages; page++) {
    const { data, error } = await fetchPage(afterKey, pageSize);
    if (error) return { rows: [], error: error.message };
    const batch = data ?? [];
    if (batch.length === 0) return { rows, error: null };
    const last = keyOf(batch[batch.length - 1]);
    if (afterKey !== null && !(last > afterKey)) {
      // The page did not move forward: the query is not ordered by the key, or
      // ignores the after-key filter. Refuse rather than loop or duplicate.
      return { rows: [], error: `paging did not advance past ${afterKey}` };
    }
    rows.push(...batch);
    afterKey = last;
  }
  return { rows: [], error: `more than ${maxPages} pages of ${pageSize} rows` };
}

/** Page size for marketing reads. Overridable per environment so staging, which
 *  has ~100 recipients, can prove a multi-page send with a tiny page. Falls back
 *  to 1000 for anything missing, non-numeric or out of 1..1000. */
export function marketingReadPageSize(raw: string | undefined | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 1000;
}
