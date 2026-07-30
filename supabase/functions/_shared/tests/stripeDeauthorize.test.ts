// Tests for classifyDeauthorizeError (2026-07-30).
//
// The cases that matter here are the ones where a WRONG answer is silent:
//   * a bare `invalid_client` must be FATAL, not "already gone". Stripe returns
//     that same code when our client_id is wrong or when a test key is used
//     against a live client_id, and treating it as "already disconnected" would
//     mark orgs disconnected en masse after a bad key rotation while enrops still
//     had live access to their Stripe accounts.
//   * `no_deauth_on_controlled_account` must NOT be fatal, or an operator on the
//     "I don't use Stripe yet" path could never detach the account we made them.
//
// Run: deno test supabase/functions/_shared/tests/stripeDeauthorize.test.ts
// (No permission flags needed - this imports a pure function.)

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { classifyDeauthorizeError } from '../stripeDeauthorize.ts';

Deno.test('controlled account is recognised from the code', () => {
  assertEquals(
    classifyDeauthorizeError('no_deauth_on_controlled_account', ''),
    'controlled_account',
  );
});

Deno.test('controlled account is recognised from the description', () => {
  // Stripe puts this in `error` sometimes and in `error_description` others.
  assertEquals(
    classifyDeauthorizeError(
      'invalid_client',
      'no_deauth_on_controlled_account: This account cannot be disconnected.',
    ),
    'controlled_account',
  );
});

Deno.test('grant already gone is recognised', () => {
  const descriptions = [
    "The account acct_123 isn't connected to your application.",
    'The account is not connected to your application',
    'No such account: acct_123',
    'That account does not exist',
    "That account doesn't exist",
  ];
  for (const d of descriptions) {
    assertEquals(classifyDeauthorizeError('invalid_client', d), 'already_gone', d);
  }
});

Deno.test('bare invalid_client is FATAL, not already_gone', () => {
  // The whole point of the narrow description match. A key/client_id mismatch
  // reports invalid_client with no "not connected" wording.
  assertEquals(classifyDeauthorizeError('invalid_client', ''), 'fatal');
  assertEquals(
    classifyDeauthorizeError('invalid_client', 'The client_id provided does not belong to you.'),
    'fatal',
  );
  assertEquals(
    classifyDeauthorizeError(
      'invalid_client',
      'You did not provide an API key in live mode but supplied a live mode client_id.',
    ),
    'fatal',
  );
});

Deno.test('invalid_request is fatal', () => {
  assertEquals(
    classifyDeauthorizeError('invalid_request', 'No stripe_user_id parameter provided.'),
    'fatal',
  );
});

Deno.test('unknown, empty and null inputs are fatal', () => {
  // Fail closed: an error we cannot identify must never be read as success.
  assertEquals(classifyDeauthorizeError(null, null), 'fatal');
  assertEquals(classifyDeauthorizeError(undefined, undefined), 'fatal');
  assertEquals(classifyDeauthorizeError('', ''), 'fatal');
  assertEquals(classifyDeauthorizeError('rate_limit', 'Too many requests'), 'fatal');
  assertEquals(classifyDeauthorizeError('api_error', 'An unexpected error occurred'), 'fatal');
});

Deno.test('matching is case-insensitive', () => {
  assertEquals(
    classifyDeauthorizeError('NO_DEAUTH_ON_CONTROLLED_ACCOUNT', ''),
    'controlled_account',
  );
  assertEquals(
    classifyDeauthorizeError('INVALID_CLIENT', "The account ISN'T CONNECTED to your application."),
    'already_gone',
  );
});
