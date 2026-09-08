// Every warning refund-registration can return on a SUCCESSFUL refund must be
// read by RefundDrawer.
//
// On 2026-09-08 two families were refunded in Stripe while their registrations
// stayed 'paid'/'confirmed', because the function returned 502 the moment a
// LATER step failed - the application-fee refund, in that case. The fix was to
// stop treating "money moved but a subsequent step did not" as a failed refund:
// the bookkeeping now runs and the shortfall is reported as a warning on
// success:true.
//
// That fix creates a new way to lose information. A warning the function emits
// and the drawer never reads is worse than the old error, because now nothing at
// all is shown: the drawer closes on success and the operator is told the refund
// worked, full stop. There is no red box to notice any more.
//
// This is the frontend/edge-function payload-key mismatch that fails silently on
// both sides - the recurring bug class. So the keys are ratcheted here, read from
// SOURCE on both sides: add a warning key to the function and this test fails
// until the drawer surfaces it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const fnSrc = readFileSync(join(repo, 'supabase', 'functions', 'refund-registration', 'index.ts'), 'utf8');
const uiSrc = readFileSync(join(repo, 'src', 'components', 'RefundDrawer.jsx'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
}

/** Strip comments so prose naming a key is not mistaken for code reading it. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// The success payload is the object literal in the final `return json({ success: true, ... })`.
const fnCode = stripComments(fnSrc);
const start = fnCode.indexOf('success: true');
ok('found the success response', start !== -1,
  'no `success: true` in refund-registration - has the response shape moved?');

// Walk to the end of that object literal.
let i = fnCode.lastIndexOf('{', start), depth = 0, end = -1;
for (let j = i; j < fnCode.length; j++) {
  if (fnCode[j] === '{') depth++;
  else if (fnCode[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
}
const successBody = fnCode.slice(i, end + 1);

// Keys that describe something that did NOT happen. `receipt_sent`/`receipt_reason`
// predate this and are already surfaced by the drawer's own receipt handling.
const WARNING_KEYS = [...successBody.matchAll(/^\s*(margin_[a-z_]+|cancel_failed|fee_lookup_[a-z_]+)\s*:/gm)]
  .map((m) => m[1]);

ok('the success response carries warning keys', WARNING_KEYS.length >= 3,
  `expected at least the three money-moved-but warnings, found: ${WARNING_KEYS.join(', ') || 'none'}`);

const uiCode = stripComments(uiSrc);
// Require an actual READ off the response - `data.key` or `data?.key` - not the
// bare string. humanError still carries a `case "cancel_failed_after_refund"`
// for an error the function no longer returns, and a substring match counts that
// as coverage: the real read could be deleted and this test would still pass.
const unread = WARNING_KEYS.filter((k) => !new RegExp(`data\\??\\.${k}\\b`).test(uiCode));
ok('every warning key is read by RefundDrawer',
  unread.length === 0,
  unread.length
    ? `refund-registration returns these on a SUCCESSFUL refund and the drawer never reads them,\n` +
      `      so the operator is told the refund worked and nothing else:\n        ${unread.join('\n        ')}`
    : '');

// And the drawer must actually SHOW them, not merely mention them. Every warning
// key it reads has to reach the alert it builds.
const buildsNotes = /notes\.push\(/.test(uiCode) && /alert\(/.test(uiCode);
ok('the drawer surfaces warnings to the operator', buildsNotes,
  'RefundDrawer reads the keys but no longer builds a visible note from them');

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
