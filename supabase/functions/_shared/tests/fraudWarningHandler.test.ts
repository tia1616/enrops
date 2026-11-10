// Pins the send-once machinery of handleEarlyFraudWarning in CI: claim,
// redelivery, stale takeover, fresh-held retry, release on failure. The same
// branches were proven against the staging database by hand (2026-11-10);
// this keeps them from regressing silently.
import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { handleEarlyFraudWarning } from '../fraudWarningAlert.ts';

type Row = Record<string, any>;

// A tiny in-memory stand-in for the supabase-js query builder, covering only
// the calls the handler makes. UNIQUE(stripe_warning_id) on fraud_warnings is
// enforced so the 23505 path is real.
function memDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = structuredClone(seed);
  tables.fraud_warnings ??= [];
  function q(table: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row | null = null;
    let returning = false;
    const filters: ((r: Row) => boolean)[] = [];
    let single = false;
    const run = () => {
      const rows = tables[table] ?? (tables[table] = []);
      if (op === 'insert') {
        if (table === 'fraud_warnings' && rows.some((r) => r.stripe_warning_id === payload!.stripe_warning_id)) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        rows.push({ alerted_at: null, ...payload });
        return { data: null, error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'update') {
        hit.forEach((r) => Object.assign(r, payload));
        return { data: returning ? hit.map((r) => ({ id: r.id ?? r.stripe_warning_id })) : null, error: null };
      }
      if (op === 'delete') {
        tables[table] = rows.filter((r) => !hit.includes(r));
        return { data: null, error: null };
      }
      return { data: single ? (hit[0] ?? null) : hit, error: null };
    };
    const chain: any = {
      select: () => { if (op !== 'select') returning = true; return chain; },
      insert: (p: Row) => { op = 'insert'; payload = p; return chain; },
      update: (p: Row) => { op = 'update'; payload = p; return chain; },
      delete: () => { op = 'delete'; return chain; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return chain; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return chain; },
      lt: (c: string, v: string) => { filters.push((r) => r[c] < v); return chain; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return chain; },
      limit: () => chain,
      maybeSingle: () => { single = true; return Promise.resolve(run()); },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return chain;
  }
  return { tables, from: q };
}

const ORG = 'org-1';
const seed = {
  registrations: [{ id: 'reg-1', organization_id: ORG, stripe_payment_intent_id: 'pi_1', parent_id: 'par-1', students: { first_name: 'Clark' }, programs: { curriculum: 'LEGO', program_locations: { name: 'Library' } } }],
  installments: [],
  parents: [{ id: 'par-1', first_name: 'Carrie', last_name: 'P', email: 'c@example.com', phone: '1' }],
  organizations: [{ id: ORG, timezone: 'America/Los_Angeles' }],
};
const ev = (id: string) => ({ account: null, data: { object: { id, charge: 'ch_1', payment_intent: 'pi_1', fraud_type: 'unauthorized_use_of_card' } } });

function harness(opts: { fail?: boolean; inbox?: string | null; now?: number } = {}) {
  const db = memDb(seed);
  const sent: string[] = [];
  let now = opts.now ?? Date.parse('2026-11-10T12:00:00Z');
  const deps = {
    retrieveCharge: async () => ({ amount: 100, created: 1793667791, calculated_statement_descriptor: 'X' }),
    loadBrand: async () => ({ tenant_alert_email: opts.inbox === undefined ? 'ops@example.com' : opts.inbox }),
    sendAlert: async (_b: unknown, to: string | null, _s: string, _body: string, key: string) => {
      if (opts.fail || !to) return false;
      sent.push(key);
      return true;
    },
    now: () => now,
  };
  return { db, sent, deps, advance: (ms: number) => { now += ms; }, setFail: (f: boolean) => { opts.fail = f; } };
}

Deno.test('first delivery sends once, keyed by the warning id, and stamps alerted_at', async () => {
  const h = harness();
  assertEquals(await handleEarlyFraudWarning(h.db, ev('w1'), h.deps), 'done');
  assertEquals(h.sent, ['efw-w1']);
  assert(h.db.tables.fraud_warnings[0].alerted_at);
});

Deno.test('redelivery of a SENT warning sends nothing and answers done', async () => {
  const h = harness();
  await handleEarlyFraudWarning(h.db, ev('w1'), h.deps);
  h.advance(60 * 60 * 1000); // long after: a sent claim is never stale
  assertEquals(await handleEarlyFraudWarning(h.db, ev('w1'), h.deps), 'done');
  assertEquals(h.sent.length, 1);
});

Deno.test('a FRESH unsent claim (holder mid-send or dead) answers retry, never done', async () => {
  const h = harness();
  h.db.tables.fraud_warnings.push({ stripe_warning_id: 'w2', organization_id: ORG, alerted_at: null, created_at: new Date(h.deps.now()).toISOString() });
  assertEquals(await handleEarlyFraudWarning(h.db, ev('w2'), h.deps), 'retry');
  assertEquals(h.sent.length, 0);
});

Deno.test('a STALE unsent claim is taken over and sent', async () => {
  const h = harness();
  h.db.tables.fraud_warnings.push({ stripe_warning_id: 'w3', organization_id: ORG, alerted_at: null, created_at: new Date(h.deps.now() - 10 * 60 * 1000).toISOString() });
  assertEquals(await handleEarlyFraudWarning(h.db, ev('w3'), h.deps), 'done');
  assertEquals(h.sent, ['efw-w3']);
});

Deno.test('a failed send releases the claim and answers retry; the retry then sends', async () => {
  const h = harness({ fail: true });
  assertEquals(await handleEarlyFraudWarning(h.db, ev('w4'), h.deps), 'retry');
  assertEquals(h.db.tables.fraud_warnings.length, 0);
  h.setFail(false);
  assertEquals(await handleEarlyFraudWarning(h.db, ev('w4'), h.deps), 'done');
  assertEquals(h.sent, ['efw-w4']);
});

Deno.test('no inbox (or a brand read that looked like none) retries instead of answering done', async () => {
  const h = harness({ inbox: null });
  assertEquals(await handleEarlyFraudWarning(h.db, ev('w5'), h.deps), 'retry');
  assertEquals(h.db.tables.fraud_warnings.length, 0);
});

Deno.test('a charge enrops has no record of: done, no claim, no email', async () => {
  const h = harness();
  const e = { account: null, data: { object: { id: 'w6', charge: 'ch_x', payment_intent: 'pi_unknown' } } };
  assertEquals(await handleEarlyFraudWarning(h.db, e, h.deps), 'done');
  assertEquals(h.db.tables.fraud_warnings.length, 0);
  assertEquals(h.sent.length, 0);
});
