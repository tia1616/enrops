// Tests for the auth-redirect-error reader.
//
// These exist because BOTH rules below were got wrong once and neither was
// caught by a build, a type-check or a browser click-through:
//
//   1. A bare `error=access_denied` was treated as an expired link. That is the
//      OAuth code for the user DECLINING consent, so cancelling the Google
//      button told people a sign-in link had expired when they never clicked
//      one.
//   2. The generic copy asserted "with that link" on a path that is also
//      reached for Google failures, where there is no link.
//
// Both are conditional-copy bugs: a branch that is not true in every state that
// selects it. A string assertion is the only cheap way to pin them.

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import {
  readAuthRedirectError,
  genericAuthErrorMessage,
  EXPIRED_LINK_MESSAGE,
} from '../../../../src/lib/authRedirectError.js';

// --- what counts as an expired link ---

Deno.test('otp_expired alone is an expired link', () => {
  const r = readAuthRedirectError('#error_code=otp_expired');
  assertEquals(r?.isExpiredLink, true);
});

Deno.test('the real Supabase stale-magic-link hash is an expired link', () => {
  // Captured verbatim from a live failure on 2026-08-01.
  const r = readAuthRedirectError(
    '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
  );
  assertEquals(r?.isExpiredLink, true);
  assertEquals(r?.description, 'Email link is invalid or has expired');
});

Deno.test('bare access_denied is NOT an expired link (user declined OAuth)', () => {
  // The regression this file exists to prevent: someone cancels the Google
  // consent screen and must not be told their link expired.
  const r = readAuthRedirectError('#error=access_denied');
  assertEquals(r === null, false, 'still an auth error worth reporting');
  assertEquals(r?.isExpiredLink, false, 'but NOT an expired link');
});

Deno.test('access_denied as error_code is also not an expired link', () => {
  const r = readAuthRedirectError('#error_code=access_denied');
  assertEquals(r?.isExpiredLink, false);
});

Deno.test('server_error is reported but not as an expiry', () => {
  const r = readAuthRedirectError('#error=server_error&error_description=Database+error');
  assertEquals(r?.isExpiredLink, false);
  assertEquals(r?.description, 'Database error');
});

// --- non-errors must stay null ---

Deno.test('no hash returns null', () => {
  assertEquals(readAuthRedirectError(''), null);
  assertEquals(readAuthRedirectError('#'), null);
});

Deno.test('a SUCCESSFUL auth hash returns null', () => {
  // Supabase puts the session in the fragment on success. Treating that as an
  // error would show a failure banner to someone who just signed in fine.
  assertEquals(
    readAuthRedirectError('#access_token=abc123&expires_in=3600&token_type=bearer'),
    null,
  );
});

// --- copy must not assert how the person was signing in ---

Deno.test('generic copy never claims a link was used', () => {
  const withDetail = genericAuthErrorMessage({ description: 'Database error granting user' });
  const noDetail = genericAuthErrorMessage({ description: '' });
  for (const msg of [withDetail, noDetail]) {
    assertEquals(/link/i.test(msg), false, `generic copy must not mention a link: ${msg}`);
  }
  assertEquals(withDetail.includes('Database error granting user'), true);
});

Deno.test('only the expired-link message mentions a link', () => {
  assertEquals(/link/i.test(EXPIRED_LINK_MESSAGE), true);
});

Deno.test('shared copy points at no particular control', () => {
  // Three surfaces put the action in three different places, so a sentence
  // naming one of them is false on the other two.
  for (const msg of [EXPIRED_LINK_MESSAGE, genericAuthErrorMessage({ description: '' })]) {
    assertEquals(/\b(below|above)\b/i.test(msg), false, `must not point at a control: ${msg}`);
  }
});
