// sendLedger.test.ts — regression cover for the 2026-09-22 duplicate welcome.
//
// 93 families got the same email 8 times because a pre-check that FAILED was
// read as a pre-check that found nothing. Every test below is one of the two
// facts that had to be true for that to happen, asserted so it cannot be true
// again. The last two run against the real staging database, because the defect
// was a TRANSPORT limit — no fake can prove a URL is short enough.

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  CLAIM_MARKER,
  claimSend,
  INTERRUPTED_MARKER,
  type LedgerClient,
  loadPriorSends,
  PRECHECK_CHUNK_SIZE,
  reclaimStaleClaims,
  STALE_CLAIM_AFTER_MS,
} from "./sendLedger.ts";

// ── A chainable stub of the fragment of supabase-js these functions use ──────
type Resp = { data?: unknown; error?: unknown };

function stubClient(handlers: {
  select?: (chunk: string[]) => Resp;
  insert?: (row: Record<string, unknown>) => Resp;
  update?: (row: Record<string, unknown>, filters: Record<string, unknown>) => Resp;
  scan?: (filters: Record<string, unknown>) => Resp;
}) {
  const calls = {
    selectChunks: [] as string[][],
    inserts: [] as Record<string, unknown>[],
    updates: [] as Array<{ row: Record<string, unknown>; filters: Record<string, unknown> }>,
    scans: [] as Record<string, unknown>[],
  };
  const client: LedgerClient = {
    from() {
      const filters: Record<string, unknown> = {};
      let mode: "select" | "insert" | "update" = "select";
      let row: Record<string, unknown> = {};
      const builder: any = {
        select() { return builder; },
        eq(col: string, val: unknown) { filters[col] = val; return builder; },
        lt(col: string, val: unknown) { filters[`${col}__lt`] = val; return builder; },
        limit(n: number) { filters.__limit = n; return builder; },
        in(_col: string, chunk: string[]) {
          calls.selectChunks.push(chunk);
          return Promise.resolve(handlers.select?.(chunk) ?? { data: [], error: null });
        },
        insert(r: Record<string, unknown>) {
          mode = "insert"; row = r; calls.inserts.push(r);
          return Promise.resolve(handlers.insert?.(r) ?? { data: null, error: null });
        },
        update(r: Record<string, unknown>) { mode = "update"; row = r; return builder; },
        then(res: (v: Resp) => unknown) {
          if (mode === "update") {
            calls.updates.push({ row, filters });
            return Promise.resolve(handlers.update?.(row, filters) ?? { data: [], error: null }).then(res);
          }
          calls.scans.push({ ...filters });
          return Promise.resolve(handlers.scan?.(filters) ?? { data: [], error: null }).then(res);
        },
      };
      return builder;
    },
  };
  return { client, calls };
}

const TARGET = {
  automationId: "a0000000-0000-0000-0000-000000000001",
  organizationId: "b0000000-0000-0000-0000-000000000002",
  runId: "c0000000-0000-0000-0000-000000000003",
  parentId: "d0000000-0000-0000-0000-000000000004",
  contextKey: "program:p:parent:q:student:r",
  email: "parent@example.com",
};

const keysN = (n: number) =>
  Array.from({ length: n }, (_, i) => `program:${i}:parent:${i}:student:${i}`);

// ── loadPriorSends ──────────────────────────────────────────────────────────

Deno.test("the pre-check never asks for more keys than one request can carry", () => {
  // The whole incident in one number: 102 keys in ONE request is what broke.
  assert(PRECHECK_CHUNK_SIZE <= 101, "chunk must stay under the measured 102-key ceiling");
});

Deno.test("a 102-key audience is split, and every prior send is still seen", async () => {
  const keys = keysN(102);
  const { client, calls } = stubClient({
    select: (chunk) => ({
      data: chunk.map((k) => ({ context_key: k, status: "sent", attempts: 1 })),
      error: null,
    }),
  });
  const prior = await loadPriorSends(client, TARGET.automationId, keys);
  assertEquals(prior.size, 102, "every prior send must survive the chunking");
  assertEquals(calls.selectChunks.length, 3);
  for (const c of calls.selectChunks) assert(c.length <= PRECHECK_CHUNK_SIZE);
  // The exact regression: the 102nd family must be known to have been mailed.
  assertEquals(prior.get(keys[101])?.status, "sent");
});

Deno.test("a FAILED pre-check throws — it must never read as 'nobody has been mailed'", async () => {
  // This is the 2026-09-22 defect. The old code destructured only `data`, so
  // this case returned an empty map and the caller mailed all 102 families.
  const { client } = stubClient({
    select: () => ({ data: null, error: { message: "Headers Overflow Error" } }),
  });
  await assertRejects(
    () => loadPriorSends(client, TARGET.automationId, keysN(102)),
    Error,
    "refusing to send",
  );
});

Deno.test("a pre-check that returns neither rows nor an error also throws", async () => {
  const { client } = stubClient({ select: () => ({ data: null, error: null }) });
  await assertRejects(() => loadPriorSends(client, TARGET.automationId, keysN(3)), Error, "refusing to send");
});

Deno.test("a later chunk failing still stops the run, not just the first", async () => {
  let n = 0;
  const { client } = stubClient({
    select: (chunk) => (++n === 3
      ? { data: null, error: { message: "boom" } }
      : { data: chunk.map((k) => ({ context_key: k, status: "sent", attempts: 1 })), error: null }),
  });
  await assertRejects(() => loadPriorSends(client, TARGET.automationId, keysN(120)), Error, "refusing to send");
});

// ── claimSend ───────────────────────────────────────────────────────────────

Deno.test("a clean insert claims the send", async () => {
  const { client, calls } = stubClient({ insert: () => ({ error: null }) });
  assertEquals(await claimSend(client, TARGET, 0), true);
  assertEquals(calls.inserts[0].status, "failed");
  assertEquals(calls.inserts[0].attempts, 1);
  assertEquals(calls.inserts[0].error_message, CLAIM_MARKER);
});

Deno.test("losing the insert race to a concurrent run does NOT send", async () => {
  // The other run already incremented attempts past what we read, so the
  // guarded update matches nothing and we stand down without mailing.
  const { client } = stubClient({
    insert: () => ({ error: { code: "23505" } }),
    update: () => ({ data: [], error: null }),
  });
  assertEquals(await claimSend(client, TARGET, 0), false);
});

Deno.test("a genuine retry of a recorded failure still claims", async () => {
  const { client, calls } = stubClient({
    insert: () => ({ error: { code: "23505" } }),
    update: () => ({ data: [{ id: "row-1" }], error: null }),
  });
  assertEquals(await claimSend(client, TARGET, 2), true);
  const u = calls.updates[0];
  assertEquals(u.row.attempts, 3, "a retry advances from exactly what we read");
  assertEquals(u.filters.attempts, 2, "optimistic lock on the value we pre-checked");
  assertEquals(u.filters.status, "failed", "a row that already SENT can never be re-claimed");
});

Deno.test("an insert that fails for any other reason does NOT send", async () => {
  // Cannot record the claim => cannot prove the send is ours => stay silent.
  const { client } = stubClient({ insert: () => ({ error: { code: "42501", message: "denied" } }) });
  assertEquals(await claimSend(client, TARGET, 0), false);
});

Deno.test("an update error does NOT send", async () => {
  const { client } = stubClient({
    insert: () => ({ error: { code: "23505" } }),
    update: () => ({ data: null, error: { message: "boom" } }),
  });
  assertEquals(await claimSend(client, TARGET, 0), false);
});

Deno.test("a held claim does not look like a bad address to the operator screens", () => {
  // Mirrors isPermanentFailure() in src/lib/deliveryIssues.js. If CLAIM_MARKER
  // ever matched, every in-flight send would render as "The email address on
  // file looks invalid" and delivery-alert-cron would email the operator about
  // a family who is being mailed correctly, right now.
  assertEquals(/resend (\d{3})/i.test(CLAIM_MARKER), false);
});

// ── reclaimStaleClaims ──────────────────────────────────────────────────────
// A claim is written BEFORE the send, so a run that dies in between leaves a row
// that looks exactly like a real failed attempt. Left alone it burns one of the
// five retries, and five interruptions would drop the family for good while
// telling the operator we could not reach their inbox. These pin the undo.

Deno.test("a claim can never be reclaimed while a run could still be holding it", () => {
  // Edge functions are killed at 150s, so nothing can legitimately still be
  // sending after that. The cutoff must stay comfortably beyond it, or we would
  // reclaim a live send and mail the family twice.
  assert(STALE_CLAIM_AFTER_MS > 150_000 * 2, "cutoff must be well clear of the 150s function ceiling");
});

Deno.test("an interrupted send gives its retry back", async () => {
  const { client, calls } = stubClient({
    scan: () => ({ data: [{ id: "r1", attempts: 3 }], error: null }),
    update: () => ({ data: [{ id: "r1" }], error: null }),
  });
  assertEquals(await reclaimStaleClaims(client, TARGET.automationId, new Date("2026-09-22T16:00:00Z")), 1);

  // Scanned for held claims only, older than the cutoff.
  const scan = calls.scans[0];
  assertEquals(scan.automation_id, TARGET.automationId);
  assertEquals(scan.status, "failed");
  assertEquals(scan.error_message, CLAIM_MARKER);
  assertEquals(scan.last_attempt_at__lt, new Date(Date.parse("2026-09-22T16:00:00Z") - STALE_CLAIM_AFTER_MS).toISOString());

  // Undid exactly what the claim added, and stopped calling it a held claim.
  const u = calls.updates[0];
  assertEquals(u.row.attempts, 2, "the retry the claim spent is handed back");
  assertEquals(u.row.error_message, INTERRUPTED_MARKER);
  assertEquals(u.filters.attempts, 3, "guarded on what the scan read");
  assertEquals(u.filters.error_message, CLAIM_MARKER);
});

Deno.test("a reclaimed row cannot be reclaimed again and walked down to zero", () => {
  // The repair rewrites error_message, so the next scan (which matches only
  // CLAIM_MARKER) cannot see it. Without this a row could lose an attempt on
  // every run until it hit zero and the ladder stopped meaning anything.
  assert(INTERRUPTED_MARKER !== CLAIM_MARKER);
});

Deno.test("attempts never goes below zero", async () => {
  const { client, calls } = stubClient({
    scan: () => ({ data: [{ id: "r1", attempts: 0 }], error: null }),
    update: () => ({ data: [{ id: "r1" }], error: null }),
  });
  await reclaimStaleClaims(client, TARGET.automationId);
  assertEquals(calls.updates[0].row.attempts, 0);
});

Deno.test("a null attempts is treated as zero, not as NaN", async () => {
  const { client, calls } = stubClient({
    scan: () => ({ data: [{ id: "r1", attempts: null }], error: null }),
    update: () => ({ data: [{ id: "r1" }], error: null }),
  });
  await reclaimStaleClaims(client, TARGET.automationId);
  assertEquals(calls.updates[0].row.attempts, 0);
});

Deno.test("a row another run touched since the scan is left alone", async () => {
  const { client } = stubClient({
    scan: () => ({ data: [{ id: "r1", attempts: 3 }], error: null }),
    update: () => ({ data: [], error: null }), // guard matched nothing
  });
  assertEquals(await reclaimStaleClaims(client, TARGET.automationId), 0);
});

Deno.test("a failed scan is non-fatal — repairing is best-effort, the pre-check is the gate", async () => {
  // Deliberately the OPPOSITE of loadPriorSends. Not repairing delays one
  // family; refusing to run would stop every send for the whole automation.
  const { client } = stubClient({ scan: () => ({ data: null, error: { message: "boom" } }) });
  assertEquals(await reclaimStaleClaims(client, TARGET.automationId), 0);
});

Deno.test("an interrupted row does not read as a bad address to the operator screens", () => {
  // Same bar as CLAIM_MARKER: src/lib/deliveryIssues.js isPermanentFailure must
  // not match, or a family whose send was merely interrupted is shown as having
  // an invalid email and delivery-alert-cron emails the operator about it.
  assertEquals(/resend (\d{3})/i.test(INTERRUPTED_MARKER), false);
});

// ── Against the real staging database ────────────────────────────────────────
// Skipped unless STAGING_DB_URL + STAGING_SERVICE_KEY are set, so CI stays
// hermetic. These are the two facts a stub cannot establish: that the chunked
// URL actually fits, and that Postgres really does reject the second claimer.

// Read lazily and defensively. CI runs `deno test` WITHOUT --allow-env on
// purpose, so that a test can never reach a real Supabase or Stripe. A bare
// Deno.env.get at module scope therefore throws NotCapable before a single
// Deno.test registers, which does not skip this file - it fails the whole job
// and silently takes all 22 tests with it. That is how this file shipped on
// 2026-09-22 contributing zero coverage while looking green locally.
function envOrUndefined(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}
const DB = envOrUndefined("STAGING_DB_URL");
const SK = envOrUndefined("STAGING_SERVICE_KEY");
const AUTO_ID = envOrUndefined("STAGING_AUTOMATION_ID");
const ORG_ID = envOrUndefined("STAGING_ORG_ID");
const RUN_ID = envOrUndefined("STAGING_RUN_ID");
// Every id the live tests need is part of the gate, so a half-configured run
// can never report "ok" having asserted nothing.
const live = !!(DB && SK);
const liveWithFixtures = !!(live && AUTO_ID && ORG_ID && RUN_ID);

function restClient(): LedgerClient {
  const H = { apikey: SK!, Authorization: `Bearer ${SK!}`, "Content-Type": "application/json" };
  return {
    from(table: string) {
      const qs: string[] = [];
      let body: unknown = null;
      let verb: "GET" | "POST" | "PATCH" = "GET";
      let sel = "*";
      const run = async (): Promise<Resp> => {
        const url = `${DB}/rest/v1/${table}?${qs.join("&")}${verb === "GET" ? `&select=${sel}` : `&select=${sel}`}`;
        const r = await fetch(url, {
          method: verb,
          headers: verb === "GET" ? H : { ...H, Prefer: "return=representation" },
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await r.text();
        if (!r.ok) {
          let code: string | undefined;
          try { code = JSON.parse(text).code; } catch { /* non-JSON gateway error */ }
          return { data: null, error: { code, message: text.slice(0, 200) } };
        }
        return { data: text ? JSON.parse(text) : [], error: null };
      };
      const b: any = {
        select(c: string) { sel = c; return b; },
        eq(col: string, v: unknown) { qs.push(`${col}=eq.${encodeURIComponent(String(v))}`); return b; },
        lt(col: string, v: unknown) { qs.push(`${col}=lt.${encodeURIComponent(String(v))}`); return b; },
        limit(n: number) { qs.push(`limit=${n}`); return b; },
        in(col: string, arr: string[]) {
          qs.push(`${col}=in.(${arr.map((v) => `"${v}"`).join(",")})`);
          return run();
        },
        insert(r: Record<string, unknown>) { verb = "POST"; body = r; sel = "id"; return run(); },
        update(r: Record<string, unknown>) { verb = "PATCH"; body = r; return b; },
        then(res: (v: Resp) => unknown) { return run().then(res); },
      };
      return b;
    },
  };
}

Deno.test({
  name: "LIVE: 200 real-shaped keys go through chunked, where one request dies",
  ignore: !live,
  fn: async () => {
    const real = (i: number) =>
      `program:101be1f8-91c5-49f6-80ba-249023${String(i).padStart(4, "0")}:parent:ebe7bd9a-5a51-4a9d-b232-ba1c4699ae8c:student:2bd56a64-4d76-4b59-b8c8-b518dbeea184`;
    const keys = Array.from({ length: 200 }, (_, i) => real(i));

    const oneShot = (ks: string[]) =>
      `${DB}/rest/v1/automation_run_recipients?select=context_key&context_key=in.(${
        ks.map((k) => `"${k}"`).join(",")
      })`;
    const usable = async (ks: string[]) => {
      try {
        const r = await fetch(oneShot(ks), { headers: { apikey: SK!, Authorization: `Bearer ${SK!}` } });
        await r.text(); // drain, or Deno reports a resource leak
        return r.ok;
      } catch {
        return false; // the request never completed — too long to send
      }
    };

    // CONTROL FIRST. Without this the test passes just as happily on a revoked
    // key or a typo'd URL, and would be asserting nothing about length at all.
    assertEquals(await usable(keys.slice(0, 10)), true, "control: short request must work, or the credentials/URL are wrong");

    // Now the only thing that changed is how many keys are in the URL.
    assertEquals(await usable(keys), false, "if one request of 200 now works, re-measure PRECHECK_CHUNK_SIZE");

    // The NEW shape: chunked, and it completes.
    const prior = await loadPriorSends(restClient(), TARGET.automationId, keys);
    assertEquals(prior.size, 0, "these synthetic keys have no rows; the point is it did not throw");
  },
});

Deno.test({
  name: "LIVE: a claim abandoned by a dead run gets its retry back, and becomes sendable again",
  ignore: !liveWithFixtures,
  fn: async () => {
    const autoId = AUTO_ID!, orgId = ORG_ID!, runId = RUN_ID!;
    const c = restClient();
    const contextKey = `selftest-stale:${crypto.randomUUID()}`;
    const H = { apikey: SK!, Authorization: `Bearer ${SK!}`, "Content-Type": "application/json" };
    const cleanup = async () => {
      const r = await fetch(
        `${DB}/rest/v1/automation_run_recipients?context_key=eq.${encodeURIComponent(contextKey)}`,
        { method: "DELETE", headers: H },
      );
      await r.text();
    };

    try {
      // A claim held since well before the cutoff: what a run killed at 150s
      // leaves behind. attempts=2 so we can see the third one handed back.
      const stamp = new Date(Date.now() - STALE_CLAIM_AFTER_MS - 60_000).toISOString();
      const ins = await fetch(`${DB}/rest/v1/automation_run_recipients`, {
        method: "POST",
        headers: { ...H, Prefer: "return=representation" },
        body: JSON.stringify({
          automation_id: autoId, organization_id: orgId, automation_run_id: runId,
          context_key: contextKey, email: "stale-selftest@example.invalid",
          status: "failed", error_message: CLAIM_MARKER, attempts: 3, last_attempt_at: stamp,
        }),
      });
      assertEquals(ins.ok, true, await ins.text());
      await ins.text().catch(() => {});

      assertEquals(await reclaimStaleClaims(c, autoId), 1, "the abandoned claim should have been repaired");

      const after = await fetch(
        `${DB}/rest/v1/automation_run_recipients?select=attempts,error_message,status&context_key=eq.${encodeURIComponent(contextKey)}`,
        { headers: H },
      );
      const [row] = await after.json();
      assertEquals(row.attempts, 2, "the retry the claim spent is back");
      assertEquals(row.error_message, INTERRUPTED_MARKER);
      assertEquals(row.status, "failed");

      // And the family is reachable again: the pre-check now sees a retryable
      // row rather than one attempt closer to being dropped for good.
      const prior = await loadPriorSends(c, autoId, [contextKey]);
      assertEquals(prior.get(contextKey)?.attempts, 2);
      assert((prior.get(contextKey)?.attempts ?? 99) < 5, "still under the retry cap, so still sendable");

      // Running again must NOT touch it a second time — that is what would walk
      // a row down to zero attempts over repeated runs.
      assertEquals(await reclaimStaleClaims(c, autoId), 0, "a repaired row must not be repaired again");
    } finally {
      await cleanup();
    }
  },
});

Deno.test({
  name: "LIVE: two runs claiming the same family — exactly one may send",
  ignore: !liveWithFixtures,
  fn: async () => {
    const autoId = AUTO_ID!, orgId = ORG_ID!, runId = RUN_ID!;
    const target = {
      automationId: autoId,
      organizationId: orgId,
      runId,
      parentId: null,
      contextKey: `selftest:${crypto.randomUUID()}`,
      email: "sendledger-selftest@example.invalid",
    };
    const c = restClient();
    const [a, b] = await Promise.all([claimSend(c, target, 0), claimSend(c, target, 0)]);
    assertEquals([a, b].filter(Boolean).length, 1, "the UNIQUE constraint must let exactly one through");
    // Clean up after ourselves — this row is test litter, not a real send.
    const del = await fetch(
      `${DB}/rest/v1/automation_run_recipients?context_key=eq.${encodeURIComponent(target.contextKey)}`,
      { method: "DELETE", headers: { apikey: SK!, Authorization: `Bearer ${SK!}` } },
    );
    await del.text();
  },
});
