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
  //
  // BOUND AT HALF THE CEILING, NOT AT THE CEILING. `<= 101` was the old
  // assertion and it permitted 101 - one key below a limit that lives in
  // PostgREST and the gateway in front of it, not in this code, and can
  // therefore move underneath us without warning. The shipped value is 50
  // precisely because the source picked half the observed ceiling; assert the
  // margin that reasoning chose, so raising the constant has to be a deliberate
  // argument rather than something that slips past a bound nobody re-read.
  assert(
    PRECHECK_CHUNK_SIZE <= 51,
    `chunk is ${PRECHECK_CHUNK_SIZE}; the measured ceiling is 102 and the design keeps ` +
      'half of it as margin. Raising this needs a fresh measurement against the real ' +
      'gateway (the LIVE tests below), not just a bigger number here.',
  );
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
  // DERIVED, not hardcoded. This used to assert a literal 3, which silently
  // pinned PRECHECK_CHUNK_SIZE to 34..50 from a test about chunking rather than
  // about the bound - so anyone re-measuring the ceiling and raising the
  // constant got an unexplained red here, in a message that said nothing about
  // why. The bound belongs in its own assertion above; this one only cares that
  // the audience was split correctly for whatever the constant is.
  assertEquals(
    calls.selectChunks.length,
    Math.ceil(102 / PRECHECK_CHUNK_SIZE),
    `102 keys at ${PRECHECK_CHUNK_SIZE} per request should be ${Math.ceil(102 / PRECHECK_CHUNK_SIZE)} chunks`,
  );
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
//
// HOW TO ACTUALLY RUN THESE, because until 2026-09-22 nothing said and so they
// had never run once since the day they were written:
//
//   STAGING_DB_URL=https://mumfymlapolsfdnpewci.supabase.co \
//   STAGING_SERVICE_KEY=<staging service_role key> \
//   STAGING_AUTOMATION_ID=<an automation id on staging> \
//   STAGING_ORG_ID=<its organization id> \
//   STAGING_RUN_ID=<any automation_runs id for it> \
//   deno test --allow-net --allow-env --allow-read=supabase/functions,supabase/migrations,src \
//     --no-check supabase/functions/lifecycle-automations-cron/sendLedger.test.ts
//
// ALL FIVE ARE REQUIRED, not just the first two. The first two set `live`, but
// the two most valuable tests - the reclaim and the claim race - are gated on
// `liveWithFixtures`, which also needs the three ids. An earlier version of this
// block listed only the first two, so someone following it verbatim would see
// "ok ... 2 ignored" and reasonably report the live gates green while the fact
// the file exists to prove went on being unproven.
//
// Worth doing whenever PRECHECK_CHUNK_SIZE is questioned: the 102-key ceiling is
// a property of PostgREST and the gateway, not of this code, so it can move
// without anything here changing. A stub can never re-measure it.

// Read lazily and defensively. CI runs `deno test` WITHOUT --allow-env on
// purpose, so that a test can never reach a real Supabase or Stripe. A bare
// Deno.env.get at module scope therefore throws NotCapable before a single
// Deno.test registers, which does not skip this file - it fails the whole job
// and silently takes all 23 tests with it. That is how this file shipped on
// 2026-09-22 contributing zero coverage while looking green locally.
function envOrUndefined(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}
// THE VARIABLE IS NAMED STAGING_*; NOTHING MAKES THAT TRUE. These tests INSERT
// into automation_run_recipients and run an automation-wide reclaim, and
// supabase/.temp/project-ref is a documented foot-gun that points at PROD. A
// prod URL exported under this name would write to real families' rows. So the
// project is asserted, not trusted: an allow-list of the one database these
// tests may touch, rather than a deny-list of the one they must not, because a
// deny-list is wrong the moment a third project exists.
const STAGING_PROJECT_REF = "mumfymlapolsfdnpewci";

// NOT thrown at module scope. A throw out here is the very bug this file was
// just fixed for: it kills every test in the file before one registers, and the
// 20 hermetic tests have nothing to do with which database somebody exported.
// Record it instead, and let the live tests fail loudly on it below.
const DB_RAW = envOrUndefined("STAGING_DB_URL");
// ANCHORED ON THE HOST, not a substring of the whole URL. `includes()` was the
// first shape and it is defeated by the ref appearing anywhere else in the
// string: `https://<prod-ref>.supabase.co/#mumfymlapolsfdnpewci` passed it, and
// these tests WRITE. Parse failures count as wrong-project, so a malformed URL
// cannot slip through either.
function isStagingHost(url: string): boolean {
  try {
    return new URL(url).hostname === `${STAGING_PROJECT_REF}.supabase.co`;
  } catch {
    return false;
  }
}
const DB_IS_WRONG_PROJECT = !!DB_RAW && !isStagingHost(DB_RAW);
const DB = DB_IS_WRONG_PROJECT ? undefined : DB_RAW;

Deno.test("a non-staging STAGING_DB_URL is refused, not quietly skipped", () => {
  // Loud, because a silent skip looks identical to "not configured" - which is
  // exactly how somebody concludes the live tests passed when they never ran.
  assert(
    !DB_IS_WRONG_PROJECT,
    `STAGING_DB_URL points at ${DB_RAW} — these tests WRITE to automation_run_recipients ` +
      `and may only run against the staging project (${STAGING_PROJECT_REF}). ` +
      'supabase/.temp/project-ref points at PROD; do not let that become this variable.',
  );
});
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
    // BEST-EFFORT ON PURPOSE. A cleanup that throws out of `finally` REPLACES
    // the assertion failure with a transport error, so the one signal that
    // matters - two runs claimed the same family - would surface as "error
    // sending request". Leaving a test row behind is the cheaper failure.
    const cleanup = async () => {
      try {
        const r = await fetch(
          `${DB}/rest/v1/automation_run_recipients?context_key=eq.${encodeURIComponent(contextKey)}`,
          { method: "DELETE", headers: H },
        );
        await r.text();
      } catch (e) {
        console.warn("[sendLedger.test] cleanup failed, leaving test row:", e);
      }
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
    // CLEAN UP IN `finally`, NOT AFTER THE ASSERTION. The sibling test above
    // does this correctly and this one did not: the DELETE sat on the line after
    // assertEquals, so it was skipped in exactly the case this test exists to
    // catch. The leftover row carries the real automation_id and organization_id
    // with CLAIM_MARKER in error_message, which renders on the operator's
    // delivery screen as a send in progress to sendledger-selftest@example.invalid
    // that never clears - test litter that looks like a live incident.
    try {
      const [a, b] = await Promise.all([claimSend(c, target, 0), claimSend(c, target, 0)]);
      assertEquals([a, b].filter(Boolean).length, 1, "the UNIQUE constraint must let exactly one through");
    } finally {
      // Best-effort, same reason as the sibling above: a throw here would
      // replace "the UNIQUE constraint must let exactly one through" with a
      // network error, on the exact run where that assertion matters most.
      try {
        const del = await fetch(
          `${DB}/rest/v1/automation_run_recipients?context_key=eq.${encodeURIComponent(target.contextKey)}`,
          { method: "DELETE", headers: { apikey: SK!, Authorization: `Bearer ${SK!}` } },
        );
        await del.text();
      } catch (e) {
        console.warn("[sendLedger.test] cleanup failed, leaving test row:", e);
      }
    }
  },
});
