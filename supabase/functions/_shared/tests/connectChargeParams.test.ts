// Tests for buildConnectChargeParams — the function that decides where the
// money lands (operator's Connect account vs. platform), how big Enrops's
// cut is, and what the parent sees on their bank statement.
//
// Pure-function tests; no Supabase or Stripe.
// Run: deno test supabase/functions/_shared/tests/connectChargeParams.test.ts

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { buildConnectChargeParams, ConnectOrgConfig } from '../connectChargeParams.ts';

// J2S-style free-tier config, fully connected and enabled.
const HAPPY_ORG: ConnectOrgConfig = {
  stripe_account_id: 'acct_1ABCDEF',
  stripe_charges_enabled: true,
  statement_descriptor_suffix: 'J2S',
  name: 'Journey to STEAM',
  platform_fee_card_pct: 0.02,
  platform_fee_ach_pct: 0.005,
  platform_fee_cap_cents: 500,
};

Deno.test('null org → returns {} (direct charge fallback)', () => {
  assertEquals(buildConnectChargeParams(25000, 'card', null, 'org-id-for-log'), {});
});

Deno.test('org with no stripe_account_id → returns {} (not yet connected)', () => {
  const org: ConnectOrgConfig = { ...HAPPY_ORG, stripe_account_id: null };
  assertEquals(buildConnectChargeParams(25000, 'card', org, 'org-id'), {});
});

Deno.test('org with empty-string stripe_account_id → returns {} (defensive)', () => {
  const org: ConnectOrgConfig = { ...HAPPY_ORG, stripe_account_id: '' };
  assertEquals(buildConnectChargeParams(25000, 'card', org, 'org-id'), {});
});

Deno.test('org with charges_enabled=false → returns {} (restricted Connect account)', () => {
  const org: ConnectOrgConfig = { ...HAPPY_ORG, stripe_charges_enabled: false };
  assertEquals(buildConnectChargeParams(25000, 'card', org, 'org-id'), {});
});

Deno.test('org with charges_enabled=null → returns {} (treat as not enabled)', () => {
  const org: ConnectOrgConfig = { ...HAPPY_ORG, stripe_charges_enabled: null };
  assertEquals(buildConnectChargeParams(25000, 'card', org, 'org-id'), {});
});

Deno.test('happy path card — returns all three params', () => {
  const result = buildConnectChargeParams(25000, 'card', HAPPY_ORG, 'org-id');
  // $250 × 2% = $5.00, which hits the cap
  assertEquals(result.application_fee_amount, 500);
  assertEquals(result.transfer_data, { destination: 'acct_1ABCDEF' });
  assertEquals(result.statement_descriptor_suffix, 'J2S');
});

Deno.test('happy path ACH — uses ACH rate, not card rate', () => {
  const result = buildConnectChargeParams(25000, 'us_bank_account', HAPPY_ORG, 'org-id');
  // $250 × 0.5% = $1.25 = 125 cents (under cap)
  assertEquals(result.application_fee_amount, 125);
  assertEquals(result.transfer_data, { destination: 'acct_1ABCDEF' });
});

Deno.test('happy path with no stored suffix → falls back to sanitized org name', () => {
  const org: ConnectOrgConfig = { ...HAPPY_ORG, statement_descriptor_suffix: null };
  const result = buildConnectChargeParams(10000, 'card', org, 'org-id');
  assertEquals(result.statement_descriptor_suffix, 'JOURNEY TO STE');
});

Deno.test('happy path with neither suffix nor org name → omits statement_descriptor_suffix', () => {
  const org: ConnectOrgConfig = {
    ...HAPPY_ORG,
    statement_descriptor_suffix: null,
    name: null,
  };
  const result = buildConnectChargeParams(10000, 'card', org, 'org-id');
  assertEquals(result.application_fee_amount, 200); // $100 × 2% = $2.00
  assertEquals(result.transfer_data, { destination: 'acct_1ABCDEF' });
  assertEquals(result.statement_descriptor_suffix, undefined);
});

Deno.test('happy path with too-short sanitized suffix → omits it', () => {
  // Org name 'A' sanitizes to 'A' which is < 3 chars, suffix should drop
  const org: ConnectOrgConfig = {
    ...HAPPY_ORG,
    statement_descriptor_suffix: null,
    name: 'A',
  };
  const result = buildConnectChargeParams(10000, 'card', org, 'org-id');
  assertEquals(result.statement_descriptor_suffix, undefined);
  // But the rest of the Connect overlay still works
  assertEquals(result.transfer_data, { destination: 'acct_1ABCDEF' });
});

Deno.test('large amount respects fee cap', () => {
  // $10,000 charge: 2% = $200, but cap is $5
  const result = buildConnectChargeParams(1_000_000, 'card', HAPPY_ORG, 'org-id');
  assertEquals(result.application_fee_amount, 500);
});

Deno.test('zero amount → fee is 0 (other fields still populated for caller to handle)', () => {
  const result = buildConnectChargeParams(0, 'card', HAPPY_ORG, 'org-id');
  assertEquals(result.application_fee_amount, 0);
  assertEquals(result.transfer_data, { destination: 'acct_1ABCDEF' });
});

Deno.test('higher-tier org config flows through correctly', () => {
  const growthOrg: ConnectOrgConfig = {
    ...HAPPY_ORG,
    platform_fee_card_pct: 0.04,
    platform_fee_cap_cents: 1000,
  };
  const result = buildConnectChargeParams(20000, 'card', growthOrg, 'org-id');
  // $200 × 4% = $8.00, under $10 cap
  assertEquals(result.application_fee_amount, 800);
});

Deno.test('transfer destination is the org stripe_account_id, not the platform', () => {
  // Defensive: make sure we never accidentally hardcode a destination
  const org: ConnectOrgConfig = { ...HAPPY_ORG, stripe_account_id: 'acct_TENANT_X' };
  const result = buildConnectChargeParams(10000, 'card', org, 'org-id');
  assertEquals(result.transfer_data?.destination, 'acct_TENANT_X');
});
