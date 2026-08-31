// Pins the post-sign-in return path. Repo convention: plain node script with a
// pass/fail counter, run by scripts/run-src-tests.mjs.
//
// THIS IS AN OPEN-REDIRECT TEST. `next` comes out of the URL, so it is
// attacker-controlled: without the guard, a mailed link like
// enrops.com/j2s/login?next=https://evil.example/pay would have the family's own
// sign-in hand them to another site. Every rejection below is a real bypass
// someone has used on somebody else's login page.
import { safeReturnPath, returnUrl } from './returnPath.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`); }
}
const FB = '/j2s/dashboard';
const safe = (v) => safeReturnPath(v, FB);

// --- what must be allowed through ------------------------------------------
// The whole point: the child editor is a UUID path, so anything that rejects
// hyphens or long paths breaks the feature it exists to serve.

eq('a plain portal path passes', safe('/j2s/dashboard'), '/j2s/dashboard');
eq('the child editor path passes (UUID, hyphens and all)',
  safe('/j2s/dashboard/child/622da1f9-7ecd-45bf-906f-012a15310ecd'),
  '/j2s/dashboard/child/622da1f9-7ecd-45bf-906f-012a15310ecd');
eq('a query string survives', safe('/j2s/dashboard?tab=classes'), '/j2s/dashboard?tab=classes');
eq('surrounding whitespace is trimmed, not rejected', safe('  /j2s/dashboard  '), '/j2s/dashboard');

// --- what must NOT ----------------------------------------------------------

eq('an absolute http url is refused', safe('http://evil.example/pay'), FB);
eq('an absolute https url is refused', safe('https://evil.example/pay'), FB);
// The classic: the browser reads "//host" as another origin entirely.
eq('a protocol-relative url is refused', safe('//evil.example/pay'), FB);
eq('a protocol-relative url with a path is refused', safe('//evil.example'), FB);
// Some browsers normalise "\" to "/", turning this into "//evil.example".
eq('a backslash bypass is refused', safe('/\\evil.example'), FB);
eq('a double backslash bypass is refused', safe('\\\\evil.example'), FB);
eq('a backslash anywhere is refused', safe('/j2s/dash\\board'), FB);
eq('a scheme-relative javascript: url is refused', safe('javascript:alert(1)'), FB);
eq('a data: url is refused', safe('data:text/html,<script>'), FB);
// A path that is not rooted could resolve relative to anything.
eq('a bare relative path is refused', safe('dashboard'), FB);
eq('a parent-relative path is refused', safe('../admin'), FB);

// --- absent, empty and wrong-typed all fall back ----------------------------

eq('undefined falls back', safe(undefined), FB);
eq('null falls back', safe(null), FB);
eq('an empty string falls back', safe(''), FB);
eq('whitespace only falls back', safe('   '), FB);
eq('a non-string falls back', safe({ toString: () => '/evil' }), FB);
eq('an array falls back', safe(['/j2s/dashboard']), FB);
eq('the default fallback is the site root', safeReturnPath(undefined), '/');

// --- control characters -----------------------------------------------------
// A decoded newline in a redirect target is how a header gets split. The class
// is written with explicit \u escapes for a reason - see the note in the module.

eq('a newline is refused', safe('/j2s/dash\nboard'), FB);
eq('a carriage return is refused', safe('/j2s/dash\rboard'), FB);
eq('a NUL is refused', safe('/j2s/dash\u0000board'), FB);
eq('a DEL is refused', safe('/j2s/dash\u007Fboard'), FB);
// ...and an ordinary path with hyphens and dots is NOT caught by that class.
eq('an ordinary path is not mistaken for a control sequence',
  safe('/j2s/dashboard/child/a-b.c_d~e'), '/j2s/dashboard/child/a-b.c_d~e');

// --- the absolute url handed to the auth provider ---------------------------

eq('a safe path becomes an absolute url on OUR origin',
  returnUrl('https://enrops.com', '/j2s/dashboard/child/abc', FB),
  'https://enrops.com/j2s/dashboard/child/abc');
eq('an unsafe path cannot escape our origin',
  returnUrl('https://enrops.com', 'https://evil.example/pay', FB),
  'https://enrops.com/j2s/dashboard');
eq('a protocol-relative attempt cannot escape our origin either',
  returnUrl('https://enrops.com', '//evil.example', FB),
  'https://enrops.com/j2s/dashboard');

console.log(`\nreturnPath: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
