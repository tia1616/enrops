// Plain-node test (repo convention: see scripts/run-src-tests.mjs).
import { parseAttribution, captureAttribution, readAttribution } from './attribution.js';

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.error('FAIL', name); } }

function memStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

ok('no tags -> null', parseAttribution('?program=abc') === null);
ok('empty -> null', parseAttribution('') === null);
const t = parseAttribution('?utm_source=enrops_email&utm_campaign=cec22f8e-2ef9-46d6-a702-ee519d2689bc&program=x');
ok('keeps utm only', t && t.utm_source === 'enrops_email' && !('program' in t));
ok('drops unsafe value', parseAttribution('?utm_source=%3Cscript%3E') === null);
ok('drops oversize value', parseAttribution('?utm_source=' + 'a'.repeat(101)) === null);

const s = memStore();
ok('capture stores', captureAttribution('?utm_source=enrops_email&utm_content=tp1', T0, s) !== null);
ok('read back', readAttribution(T0 + DAY, s)?.utm_content === 'tp1');
ok('untagged visit never erases', (captureAttribution('?foo=1', T0 + DAY, s), readAttribution(T0 + DAY, s)?.utm_content === 'tp1'));
captureAttribution('?utm_source=enrops_email&utm_content=tp2', T0 + 2 * DAY, s);
ok('last touch wins', readAttribution(T0 + 2 * DAY, s)?.utm_content === 'tp2');
ok('expires after 30 days', readAttribution(T0 + 2 * DAY + 31 * DAY, s) === null);
ok('no storage -> null, no throw', readAttribution(T0, null) === null && captureAttribution('?utm_source=a', T0, null) === null);
const bad = memStore(); bad.setItem('enrops_attr_v1', '{not json');
ok('corrupt storage -> null, no throw', readAttribution(T0, bad) === null);
const thrower = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
ok('throwing storage -> null, no throw', readAttribution(T0, thrower) === null && captureAttribution('?utm_source=a', T0, thrower) !== undefined);

console.log(`attribution: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
