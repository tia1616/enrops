// isUnreachableAddress decides whether a failed waitlist invite takes the family off
// the list. Too broad and one of OUR mistakes (bad From, bad key, bad payload) removes
// every family on the platform; too narrow and a dead address loops forever, as it did
// 78 times on prod. These pin both edges.
//
// Run: deno test --allow-net --no-check supabase/functions/lifecycle-automations-cron/waitlistUnreachable.test.ts
// (CI's own flags; no --allow-env, which is why the matcher lives in its own file.)
import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { isUnreachableAddress } from './unreachableAddress.ts';

// Verbatim from prod automation_run_recipients, 2026-10-13, for a "<name>@yahoo" address.
const PROD_BODY = '{"statusCode":422,"message":"Invalid `to` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.","name":"validation_error"}';

Deno.test('the refused-recipient 422 prod recorded is unreachable', () => {
  assertEquals(isUnreachableAddress(422, PROD_BODY), true);
});

Deno.test('a 422 about the From address is ours, not the family\'s', () => {
  const body = '{"statusCode":422,"message":"Invalid `from` field. The email address needs to follow the `email@example.com` format.","name":"validation_error"}';
  assertEquals(isUnreachableAddress(422, body), false);
});

Deno.test('a 422 for anything else is not unreachable', () => {
  assertEquals(isUnreachableAddress(422, '{"message":"Missing `subject` field.","name":"missing_required_field"}'), false);
});

Deno.test('the same message under another status is not unreachable', () => {
  assertEquals(isUnreachableAddress(400, PROD_BODY), false);
  assertEquals(isUnreachableAddress(401, PROD_BODY), false);
  assertEquals(isUnreachableAddress(500, PROD_BODY), false);
});

Deno.test('an empty body is not unreachable', () => {
  assertEquals(isUnreachableAddress(422, ''), false);
});
