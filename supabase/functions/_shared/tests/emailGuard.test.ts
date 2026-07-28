// The allowlist itself comes from an env var, so these tests exercise the
// matching RULE through a local reimplementation of the same predicate. The
// production function reads STAGING_EMAIL_ALLOWLIST at module load, which a
// test cannot vary per case.
import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';

function stripPlusTag(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const plus = local.indexOf('+');
  return plus > 0 ? local.slice(0, plus) + domain : email;
}

function allowed(list: string[], email: string): boolean {
  if (list.length === 0) return true;
  const e = (email ?? '').trim().toLowerCase();
  if (!e) return false;
  const bare = stripPlusTag(e);
  return list.some((a) => (a.startsWith('@') ? e.endsWith(a) : e === a || bare === a));
}

const LIST = ['@journeytosteam.com', 'tia1616@gmail.com'];

// THE BUG THIS FILE EXISTS FOR. Staging test inboxes are written as
// tia1616+<tag>@gmail.com by convention; the allowlist holds the untagged
// address. Exact-string matching dropped every one of them silently, so an
// email feature could look correct and deliver nothing.
Deno.test('POLICY: a plus-tagged address matches its allowlisted base', () => {
  assertEquals(allowed(LIST, 'tia1616+onboard@gmail.com'), true);
  assertEquals(allowed(LIST, 'tia1616+checkoutverify@gmail.com'), true);
  assertEquals(allowed(LIST, 'tia1616@gmail.com'), true);
});

// The widening must not reach anyone new. base+tag@ is delivered to the owner
// of base@, so this can only ever hit an inbox already permitted.
Deno.test('POLICY: an unrelated address is still blocked, tagged or not', () => {
  assertEquals(allowed(LIST, 'someone@gmail.com'), false);
  assertEquals(allowed(LIST, 'someone+tag@gmail.com'), false);
  assertEquals(allowed(LIST, 'tia1616@outlook.com'), false);
  // A tag cannot be used to impersonate a different local part.
  assertEquals(allowed(LIST, 'nottia1616+tia1616@gmail.com'), false);
});

Deno.test('domain suffix entries keep working, including for tagged addresses', () => {
  assertEquals(allowed(LIST, 'anyone@journeytosteam.com'), true);
  assertEquals(allowed(LIST, 'anyone+tag@journeytosteam.com'), true);
});

Deno.test('no allowlist means prod: everyone is allowed', () => {
  assertEquals(allowed([], 'anyone@anywhere.com'), true);
});

Deno.test('empty or malformed addresses are refused, never allowed by accident', () => {
  assertEquals(allowed(LIST, ''), false);
  assertEquals(allowed(LIST, '   '), false);
  assertEquals(allowed(LIST, '+tag@gmail.com'), false);
});
