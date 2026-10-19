// The browser forms (src/lib/validation.js emailIsValid) and the edge functions
// (supabase/functions/_shared/emailAddress.ts) must accept exactly the same
// addresses. If they drift, a form lets a family through that the server then
// refuses, or the server accepts an address the form would have caught.
//
// Run: node src/lib/emailAddressParity.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emailIsValid } from './validation.js';

let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('ok  ', name); } else { fail++; console.error('FAIL', name); }
}

const shared = readFileSync(
  fileURLToPath(new URL('../../supabase/functions/_shared/emailAddress.ts', import.meta.url)), 'utf8');
const m = /export const EMAIL_PATTERN = (\/.+\/[a-z]*);/.exec(shared);
check('shared module declares EMAIL_PATTERN', !!m);

const src = readFileSync(fileURLToPath(new URL('./validation.js', import.meta.url)), 'utf8');
const body = /export function emailIsValid[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
check('validation.js emailIsValid uses the identical pattern', !!m && body.includes(`${m[1]}.test(`));

// The case that happened on prod, and its fixed form.
check('rejects "parent@yahoo" (no dot after @)', emailIsValid('parent@yahoo') === false);
check('accepts "parent@yahoo.com"', emailIsValid('parent@yahoo.com') === true);
check('accepts surrounding spaces', emailIsValid('  a@b.co  ') === true);
check('rejects a space inside', emailIsValid('a b@c.com') === false);
check('rejects empty', emailIsValid('') === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
