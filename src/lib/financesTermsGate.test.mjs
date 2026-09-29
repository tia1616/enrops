// RATCHET: every money-settings write on the Finances page consults the terms
// gate. Self-running with a pass/fail counter, like its siblings in this folder,
// run by scripts/run-src-tests.mjs.
//
// WHY A SOURCE RATCHET AND NOT A UNIT TEST. The recurring finding in this
// repo's reviews - roughly one in three - is a fix that landed in one of the N
// places that needed it. Finances.jsx has THREE functions that write money
// settings to `organizations`, and the terms gate has to be in all three. A
// unit test of the gate itself would pass happily while a fourth writer skipped
// it, which is exactly the shape that keeps recurring.
//
// It reads source, so it proves the CALL is there, not that it works. The
// behaviour is proved separately against the live database.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? `\n  ${detail}` : ''}`); }
}

const FILE = 'src/pages/admin/Finances.jsx';
const src = readFileSync(FILE, 'utf8');

// The money columns on `organizations` this page is allowed to change.
const MONEY_SETTINGS = [
  'fee_pass_through',
  'statement_descriptor_suffix',
  'withdrawal_admin_fee_cents',
];

for (const col of MONEY_SETTINGS) {
  const at = src.indexOf(`.update({ ${col}`);
  ok(
    `${col}: the write is still findable`,
    at !== -1,
    'If the write moved or was renamed this ratchet is now blind. Point it at the new shape rather than deleting the entry.',
  );
  if (at === -1) continue;

  // Walk back to the enclosing async function and check it consults the gate.
  const fnStart = src.lastIndexOf('async function ', at);
  const name = fnStart === -1 ? '?' : (/async function (\w+)/.exec(src.slice(fnStart))?.[1] ?? '?');
  const body = fnStart === -1 ? '' : src.slice(fnStart, at);
  ok(
    `${col}: written by ${name}(), which calls blockedByTerms()`,
    body.includes('blockedByTerms('),
    'A money setting changeable without accepting the terms defeats the gate.',
  );
}

// One rule, one definition. Two copies drift and only one gets fixed.
const defs = (src.match(/function blockedByTerms\s*\(/g) || []).length;
ok('blockedByTerms is defined exactly once', defs === 1, `found ${defs} definitions`);

// The gate must be reachable: a definition nobody calls is decoration.
const calls = (src.match(/blockedByTerms\(/g) || []).length - defs;
ok('blockedByTerms is called by all three writers', calls === 3, `found ${calls} calls, expected 3`);

// src/lib/terms.js is SCHOOL terms (Fall/Winter/Spring). termsOfService.js is
// the legal agreement. This page imports BOTH, so a short name would be a wrong
// import waiting to happen on a money page.
ok(
  'the terms-of-service helper is imported by its full, unmistakable name',
  src.includes('from "../../lib/termsOfService.js"'),
);
ok(
  'school terms and the legal agreement stay separate imports',
  src.includes('from "../../lib/terms.js"') && src.includes('termsOfService.js'),
);

console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
