// readAllPages must return EVERY row, whatever the server's silent row cap is,
// and must never skip a row when the list changes between pages. The 2026-11-10
// share email reached 1,000 of 1,286 families because one read stopped at the
// cap; these tests fail if that can happen again.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { readAllPages, marketingReadPageSize, type PageResult } from "../keysetPages.ts";

type Row = { id: string };
const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(5, "0")}` }));

// A fake PostgREST: orders by id, applies id > after, returns min(limit, cap) rows.
function fakeServer(table: Row[], cap: number) {
  let calls = 0;
  const fetchPage = (after: string | null, limit: number): Promise<PageResult<Row>> => {
    calls++;
    const sorted = [...table].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const rest = after === null ? sorted : sorted.filter((r) => r.id > after);
    return Promise.resolve({ data: rest.slice(0, Math.min(limit, cap)), error: null });
  };
  return { fetchPage, calls: () => calls };
}

Deno.test("returns all 1,286 rows past a 1,000-row server cap (the 11/10 send)", async () => {
  const table = ids(1286);
  const s = fakeServer(table, 1000);
  const { rows, error } = await readAllPages(s.fetchPage, (r) => r.id, 1000);
  assertEquals(error, null);
  assertEquals(rows.length, 1286);
  assertEquals(new Set(rows.map((r) => r.id)).size, 1286, "no duplicates");
});

Deno.test("a server cap BELOW the page size still reads everything (short page is not the end)", async () => {
  const s = fakeServer(ids(2500), 300);
  const { rows, error } = await readAllPages(s.fetchPage, (r) => r.id, 1000);
  assertEquals(error, null);
  assertEquals(rows.length, 2500);
});

Deno.test("exact multiple of the page size: reads all, then stops on the empty page", async () => {
  const s = fakeServer(ids(2000), 1000);
  const { rows, error } = await readAllPages(s.fetchPage, (r) => r.id, 1000);
  assertEquals(error, null);
  assertEquals(rows.length, 2000);
  assertEquals(s.calls(), 3, "two full pages plus one empty");
});

Deno.test("empty list returns no rows and no error", async () => {
  const s = fakeServer([], 1000);
  const { rows, error } = await readAllPages(s.fetchPage, (r) => r.id, 1000);
  assertEquals(error, null);
  assertEquals(rows.length, 0);
});

Deno.test("a row dropping out between pages skips nobody else (keyset, not offset)", async () => {
  const table = ids(10);
  let call = 0;
  const fetchPage = (after: string | null, limit: number): Promise<PageResult<Row>> => {
    call++;
    // After page 1 is served, the FIRST row registers and leaves the list.
    if (call === 2) table.splice(0, 1);
    const rest = after === null ? table : table.filter((r) => r.id > after);
    return Promise.resolve({ data: rest.slice(0, limit), error: null });
  };
  const { rows, error } = await readAllPages(fetchPage, (r) => r.id, 4);
  assertEquals(error, null);
  // With OFFSET paging, id-00004 would be skipped here.
  assertEquals(rows.map((r) => r.id), ids(10).map((r) => r.id));
});

Deno.test("any page error fails closed: no partial rows", async () => {
  let call = 0;
  const fetchPage = (_after: string | null, limit: number): Promise<PageResult<Row>> => {
    call++;
    if (call === 2) return Promise.resolve({ data: null, error: { message: "canceling statement due to statement timeout" } });
    return Promise.resolve({ data: ids(limit), error: null });
  };
  const { rows, error } = await readAllPages(fetchPage, (r) => r.id, 5);
  assertEquals(rows.length, 0, "never a partial list");
  assert(error?.includes("statement timeout"));
});

Deno.test("a query that ignores the after-key errors instead of looping or duplicating", async () => {
  const fetchPage = (_after: string | null, limit: number): Promise<PageResult<Row>> =>
    Promise.resolve({ data: ids(limit), error: null });
  const { rows, error } = await readAllPages(fetchPage, (r) => r.id, 5);
  assertEquals(rows.length, 0);
  assert(error?.includes("did not advance"));
});

Deno.test("page ceiling turns a runaway read into an error", async () => {
  const s = fakeServer(ids(50), 1000);
  const { rows, error } = await readAllPages(s.fetchPage, (r) => r.id, 5, 3);
  assertEquals(rows.length, 0);
  assert(error?.includes("more than 3 pages"));
});

Deno.test("uuid strings compare in the same order Postgres sorts uuids", () => {
  // Lowercase canonical uuids: string order == byte order, so the advance check is sound.
  const a = "0f9c6a1e-0000-4000-8000-000000000000";
  const b = "a0000000-0000-4000-8000-000000000000";
  const c = "a0000000-0000-4000-8000-000000000001";
  assert(a < b && b < c);
});

Deno.test("marketingReadPageSize: default 1000, accepts 1..1000 only", () => {
  assertEquals(marketingReadPageSize(undefined), 1000);
  assertEquals(marketingReadPageSize(""), 1000);
  assertEquals(marketingReadPageSize("abc"), 1000);
  assertEquals(marketingReadPageSize("0"), 1000);
  assertEquals(marketingReadPageSize("5000"), 1000);
  assertEquals(marketingReadPageSize("2.5"), 1000);
  assertEquals(marketingReadPageSize("40"), 40);
});
