// Pins the org-save failure copy. Repo convention: plain node script with a
// pass/fail counter, run by scripts/run-src-tests.mjs.
//
// These exist because a code review found the first version of this mapping told
// an operator to "check your connection" for an expired session and for a CHECK
// violation - the same class of untrue advice this file's own comment records
// having fixed once before. A wording rule fixed by hand comes straight back the
// next time someone edits the line unless a test holds it.
import { describeOrgSaveFailure } from './orgSaveErrors.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  if (actual === expected) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n  expected: ${expected}\n  actual:   ${actual}`); }
}
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}

// Every branch returns something, and nothing leaks raw Postgres text.
const cases = [
  { label: 'expired JWT',      err: { code: 'PGRST301', message: 'JWT expired' } },
  { label: 'unauthorized',     err: { code: '401', message: 'unauthorized' } },
  { label: 'check violation',  err: { code: '23514', message: 'violates check constraint "organizations_alert_email_format"' } },
  { label: 'platform guard',   err: { code: '42501', message: 'stripe_account_id, the platform fee rate, floor and cap columns, stripe_fee_payer, instructor_pay_enabled, and instructor_pay_model can only be changed by Enrops platform admins.' } },
  { label: 'zero rows (null)', err: null },
  { label: 'zero rows (undef)',err: undefined },
  { label: 'unknown code',     err: { code: 'XX000', message: 'boom' } },
  { label: 'no code at all',   err: { message: 'network request failed' } },
];

for (const c of cases) {
  const out = describeOrgSaveFailure(c.err);
  ok(`${c.label}: returns a non-empty string`, typeof out === 'string' && out.length > 0);
  // The whole point: developer text must never reach the operator.
  ok(`${c.label}: no raw column names`, !/stripe_account_id|instructor_pay_model|platform_fee_|fee_pass_through|constraint/i.test(out));
  ok(`${c.label}: no SQLSTATE echoed`, !/\b(42501|23514|PGRST301|XX000)\b/.test(out));
}

// The specific untrue-advice regressions, named so they cannot come back quietly.
ok('expired session does NOT blame the connection',
  !/connection/i.test(describeOrgSaveFailure({ code: 'PGRST301' })));
ok('expired session DOES say to sign in again',
  /sign in again/i.test(describeOrgSaveFailure({ code: 'PGRST301' })));
ok('check violation does NOT blame the connection',
  !/connection/i.test(describeOrgSaveFailure({ code: '23514' })));
ok('check violation does NOT tell them to just retry',
  !/try again/i.test(describeOrgSaveFailure({ code: '23514' })));
ok('zero rows points at changed access, not the network',
  /access/i.test(describeOrgSaveFailure(null)) && !/connection/i.test(describeOrgSaveFailure(null)));
ok('platform guard points at contacting enrops',
  /enrops/i.test(describeOrgSaveFailure({ code: '42501' })));

// Distinctness: if two different causes produced the same sentence, the mapping
// would be decorative. These four must each read differently.
const distinct = new Set([
  describeOrgSaveFailure({ code: 'PGRST301' }),
  describeOrgSaveFailure({ code: '23514' }),
  describeOrgSaveFailure({ code: '42501' }),
  describeOrgSaveFailure(null),
]);
eq('four causes produce four distinct messages', distinct.size, 4);

console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
