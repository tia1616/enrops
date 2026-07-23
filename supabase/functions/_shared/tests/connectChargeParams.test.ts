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

// ── Stripe-fee recovery uplift (stripe_fee_payer) ──────────────────────────
// Realistic Enrops-platform tenant: 1% margin, uncapped, provider bears Stripe fee.
const TENANT_ORG: ConnectOrgConfig = {
  ...HAPPY_ORG,
  platform_fee_card_pct: 0.01,
  platform_fee_ach_pct: 0.01,
  platform_fee_cap_cents: 2147483647, // uncapped
  stripe_fee_payer: 'tenant',
};

Deno.test('BACKWARD COMPAT: unset stripe_fee_payer → no uplift (margin only)', () => {
  // HAPPY_ORG has no stripe_fee_payer, so behavior must be unchanged.
  const result = buildConnectChargeParams(20000, 'card', HAPPY_ORG, 'org-id');
  assertEquals(result.application_fee_amount, 400); // $200 × 2% only, no Stripe fee added
});

Deno.test("stripe_fee_payer='platform' (J2S) → no uplift", () => {
  const j2s: ConnectOrgConfig = { ...TENANT_ORG, stripe_fee_payer: 'platform' };
  const result = buildConnectChargeParams(20000, 'card', j2s, 'org-id');
  assertEquals(result.application_fee_amount, 200); // $200 × 1% only
});

Deno.test("stripe_fee_payer='tenant' card → 1% margin + Stripe fee ($2.00 + $6.10 = $8.10)", () => {
  const result = buildConnectChargeParams(20000, 'card', TENANT_ORG, 'org-id');
  // margin 1% = $2.00; Stripe est = round(20000*0.029)+30 = 610; total = 810
  assertEquals(result.application_fee_amount, 810);
});

Deno.test("stripe_fee_payer='tenant' ACH → 1% margin + ACH Stripe fee ($2.00 + $1.60 = $3.60)", () => {
  const result = buildConnectChargeParams(20000, 'us_bank_account', TENANT_ORG, 'org-id');
  // margin 1% = $2.00; ACH est = round(20000*0.008)=160 (under $5 cap); total = 360
  assertEquals(result.application_fee_amount, 360);
});

Deno.test('uplift never exceeds the charge amount (tiny charge cap)', () => {
  // $0.20 charge: margin ~0 + Stripe est (round(20*0.029)=1 + 30 = 31) = 31,
  // but application fee can never exceed the 20-cent charge.
  const result = buildConnectChargeParams(20, 'card', TENANT_ORG, 'org-id');
  assertEquals(result.application_fee_amount, 20);
});

Deno.test('uplift not applied when org is not connected (returns {})', () => {
  const notConnected: ConnectOrgConfig = { ...TENANT_ORG, stripe_account_id: null };
  assertEquals(buildConnectChargeParams(20000, 'card', notConnected, 'org-id'), {});
});

// ── on_behalf_of (Spec D §2) ───────────────────────────────────────────────
Deno.test("enrops_platform org → on_behalf_of set to the connected acct, suffix omitted", () => {
  const org: ConnectOrgConfig = { ...TENANT_ORG, instructor_pay_model: 'enrops_platform' };
  const result = buildConnectChargeParams(20000, 'card', org, 'org-id');
  assertEquals(result.on_behalf_of, org.stripe_account_id);
  // We send EITHER on_behalf_of OR the suffix, never both.
  assertEquals(result.statement_descriptor_suffix, undefined);
});

Deno.test("legacy/unset instructor_pay_model → no on_behalf_of, statement suffix preserved", () => {
  // HAPPY_ORG has no instructor_pay_model and a 'J2S' suffix → unchanged behavior.
  const result = buildConnectChargeParams(20000, 'card', HAPPY_ORG, 'org-id');
  assertEquals(result.on_behalf_of, undefined);
  assertEquals(result.statement_descriptor_suffix, 'J2S');
});

// ── Registration fee model floor/cap in the application fee ─────────────────
// 3% / $1.99 floor / $7.99 cap. No stripe_fee_payer → margin only, so the
// application fee IS the floored/capped platform fee (clean floor assertion).
const REG_ORG: ConnectOrgConfig = {
  ...HAPPY_ORG,
  platform_fee_card_pct: 0.03,
  platform_fee_ach_pct: 0.03,
  platform_fee_cap_cents: 799,
  platform_fee_floor_cents: 199,
};

Deno.test('reg model: small $4 charge → application fee lifted to the $1.99 floor', () => {
  const result = buildConnectChargeParams(400, 'card', REG_ORG, 'org-id');
  assertEquals(result.application_fee_amount, 199);
});

Deno.test('reg model: $300 charge → application fee clamped to the $7.99 cap', () => {
  const result = buildConnectChargeParams(30000, 'card', REG_ORG, 'org-id');
  assertEquals(result.application_fee_amount, 799);
});

Deno.test("reg model + stripe_fee_payer='tenant': floor is on the MARGIN, Stripe recovery adds on top", () => {
  // $4 charge: margin floored to 199; Stripe est = round(400*0.029)+30 = 42; total = 241.
  const result = buildConnectChargeParams(400, 'card', { ...REG_ORG, stripe_fee_payer: 'tenant' }, 'org-id');
  assertEquals(result.application_fee_amount, 241);
});
