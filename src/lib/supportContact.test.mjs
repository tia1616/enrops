// The one thing this rule must never do is hand a family the platform's inbox.
//
// Every case below was a real shape on 2026-09-14: a provider with a branding
// reply-to (the-ukulele-project), one with only an org email (branching-minds),
// and one that resolves to nothing at all (demo-chess-center on staging). The
// view does the cascade; these tests pin the normalisation and, above all, that
// an absent address stays absent.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { supportEmailOf } from './supportContact.js';

test('returns the provider address the view resolved', () => {
  assert.equal(
    supportEmailOf({ support_email: 'admin@theukuleleproject.com' }),
    'admin@theukuleleproject.com',
  );
});

test('trims, because an address with a stray space builds a broken mailto', () => {
  assert.equal(supportEmailOf({ support_email: '  info@shoreviewchess.com ' }), 'info@shoreviewchess.com');
});

test('a provider with no address gets null, never a platform fallback', () => {
  // The whole point. If this ever returns a string, a family emails Enrops
  // instead of the person teaching their child.
  assert.equal(supportEmailOf({ support_email: null }), null);
  assert.equal(supportEmailOf({ support_email: '' }), null);
  assert.equal(supportEmailOf({ support_email: '   ' }), null);
});

test('an org that has not loaded yet is null, not a crash and not a fallback', () => {
  assert.equal(supportEmailOf(null), null);
  assert.equal(supportEmailOf(undefined), null);
  assert.equal(supportEmailOf({}), null);
});

test('a non-string column value is refused rather than stringified', () => {
  // PostgREST returns null for a NULL column, but a caller passing the wrong
  // object entirely must not produce "[object Object]" inside a mailto: link.
  assert.equal(supportEmailOf({ support_email: 42 }), null);
  assert.equal(supportEmailOf({ support_email: {} }), null);
});

test('the platform address is not reachable through this function', () => {
  // A guard against the exact regression: no input shape may yield the
  // hardcoded address the portal used to print.
  for (const org of [null, undefined, {}, { support_email: null }, { support_email: '' }]) {
    assert.notEqual(supportEmailOf(org), 'jessica@enrops.com');
  }
});
