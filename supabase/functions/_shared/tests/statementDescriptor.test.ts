// Tests for buildStatementDescriptorSuffix.

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { buildStatementDescriptorSuffix } from '../statementDescriptor.ts';

Deno.test('uses stored suffix when set', () => {
  assertEquals(buildStatementDescriptorSuffix('J2S', 'Journey to STEAM'), 'J2S');
});

Deno.test('falls back to org name when suffix is null', () => {
  assertEquals(buildStatementDescriptorSuffix(null, 'Journey to STEAM'), 'JOURNEY TO STE');
});

Deno.test('falls back to org name when suffix is empty string', () => {
  assertEquals(buildStatementDescriptorSuffix('', 'Journey to STEAM'), 'JOURNEY TO STE');
});

Deno.test('uppercases everything', () => {
  assertEquals(buildStatementDescriptorSuffix(null, 'cool camps'), 'COOL CAMPS');
});

Deno.test('strips disallowed punctuation (apostrophes, slashes, quotes)', () => {
  assertEquals(buildStatementDescriptorSuffix(null, "Bob's K/12"), 'BOB S K 12');
});

Deno.test('strips asterisks (Stripe forbids them in suffix)', () => {
  assertEquals(buildStatementDescriptorSuffix(null, '*Camp*'), 'CAMP');
});

Deno.test('returns undefined for null/empty inputs', () => {
  assertEquals(buildStatementDescriptorSuffix(null, null), undefined);
  assertEquals(buildStatementDescriptorSuffix(null, ''), undefined);
  assertEquals(buildStatementDescriptorSuffix('', null), undefined);
});

Deno.test('returns undefined for too-short result (< 3 chars after sanitize)', () => {
  assertEquals(buildStatementDescriptorSuffix(null, 'A'), undefined);
  assertEquals(buildStatementDescriptorSuffix(null, '!@'), undefined);
});

Deno.test('preserves allowed punctuation (period, dash, comma)', () => {
  assertEquals(buildStatementDescriptorSuffix(null, 'Co. Ltd.'), 'CO. LTD.');
  assertEquals(buildStatementDescriptorSuffix(null, 'Mon-Fri'), 'MON-FRI');
});

Deno.test('caps at 14 chars', () => {
  assertEquals(
    buildStatementDescriptorSuffix(null, 'Pokemon LEGO Robotics Camp 2026'),
    'POKEMON LEGO R',
  );
});
