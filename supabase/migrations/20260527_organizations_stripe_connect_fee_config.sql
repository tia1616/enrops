-- 20260527_organizations_stripe_connect_fee_config.sql
--
-- Adds operator-side Stripe Connect (Express) configuration to organizations.
-- This is the OPERATOR side (parents -> org), distinct from the existing
-- INSTRUCTOR side (org -> instructors) which lives on a different Stripe
-- account entirely. Do not confuse the two.
--
-- New columns on organizations:
--   platform_fee_card_pct          - fee rate on card charges (default 2%)
--   platform_fee_ach_pct           - fee rate on ACH charges (default 0.5%)
--                                    (ACH not accepted today; column is
--                                    forward-looking)
--   platform_fee_cap_cents         - max fee per transaction (default $5)
--   fee_pass_through               - true = parent pays base + fee.
--                                    false = org absorbs fee.
--   statement_descriptor_suffix    - per-tenant suffix appended to the
--                                    platform descriptor "ENROPS" on parent
--                                    bank statements. 5-14 chars uppercased.
--                                    Example: J2S -> "ENROPS J2S".
--   withdrawal_admin_fee_cents     - per-tenant suggested admin fee for
--                                    parent withdrawals. Surfaces as a
--                                    quick-fill button on the refund drawer.
--                                    Operator policy, not Enrops's.
--   stripe_last_account_event_id   - webhook idempotency token; mirrors the
--                                    instructor-side pattern.
--
-- LOCKED columns (BEFORE UPDATE trigger raises if changed by anyone other
-- than service_role / direct DB / platform admin):
--   - stripe_account_id      (payout-theft prevention)
--   - platform_fee_card_pct  (Enrops's pricing)
--   - platform_fee_ach_pct
--   - platform_fee_cap_cents
--
-- UNLOCKED columns (org owner/admin can edit freely via Finances tab):
--   - fee_pass_through
--   - statement_descriptor_suffix
--   - withdrawal_admin_fee_cents
--
-- stripe_account_status enum is locked to a known list.
--
-- J2S (tenant #1) is seeded for the production cutover. stripe_account_id
-- is intentionally NOT seeded - the Express onboarding flow populates it.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS platform_fee_card_pct  NUMERIC(5,4) NOT NULL DEFAULT 0.02
    CHECK (platform_fee_card_pct >= 0 AND platform_fee_card_pct <= 1),
  ADD COLUMN IF NOT EXISTS platform_fee_ach_pct   NUMERIC(5,4) NOT NULL DEFAULT 0.005
    CHECK (platform_fee_ach_pct >= 0 AND platform_fee_ach_pct <= 1),
  ADD COLUMN IF NOT EXISTS platform_fee_cap_cents INTEGER      NOT NULL DEFAULT 500
    CHECK (platform_fee_cap_cents >= 0),
  ADD COLUMN IF NOT EXISTS fee_pass_through       BOOLEAN      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS statement_descriptor_suffix VARCHAR(14)
    CHECK (statement_descriptor_suffix IS NULL
           OR (char_length(statement_descriptor_suffix) BETWEEN 3 AND 14
               AND statement_descriptor_suffix ~ '^[A-Z0-9 .,\-]+$')),
  ADD COLUMN IF NOT EXISTS withdrawal_admin_fee_cents INTEGER NOT NULL DEFAULT 0
    CHECK (withdrawal_admin_fee_cents >= 0),
  ADD COLUMN IF NOT EXISTS stripe_last_account_event_id TEXT;

COMMENT ON COLUMN organizations.platform_fee_card_pct  IS 'Stripe Connect platform fee rate on card charges, fraction (0.02 = 2%). LOCKED to platform admins.';
COMMENT ON COLUMN organizations.platform_fee_ach_pct   IS 'Stripe Connect platform fee rate on ACH charges, fraction (0.005 = 0.5%). LOCKED to platform admins. ACH not yet accepted; column is forward-looking.';
COMMENT ON COLUMN organizations.platform_fee_cap_cents IS 'Max Stripe Connect platform fee per transaction in cents (500 = $5). LOCKED to platform admins.';
COMMENT ON COLUMN organizations.fee_pass_through       IS 'true = parent pays base + fee at checkout. false = org absorbs fee (parent pays base; fee deducted from operator payout). Editable by org owner/admin via Finances tab toggle.';
COMMENT ON COLUMN organizations.statement_descriptor_suffix IS 'Operator name appended to the platform descriptor "ENROPS" on parent bank statements. Stripe enforces uppercase, ASCII, 5-22 chars combined. We store up to 14 chars here so "ENROPS " (7 chars) + suffix never exceeds 22. NULL falls back to a sanitized first-14-chars of org name at charge time.';
COMMENT ON COLUMN organizations.withdrawal_admin_fee_cents IS 'Per-tenant suggested admin fee (cents) for parent-initiated withdrawals. Surfaces as a quick-fill button on the refund drawer. 0 = no admin fee suggestion. Operator business policy, not Enrops platform fee.';
COMMENT ON COLUMN organizations.stripe_last_account_event_id IS 'Webhook idempotency token. The most recent account.* event ID we processed for this org. Mirrors contractor_onboarding_status.stripe_last_webhook_event_id pattern.';

-- Lock stripe_account_status to a known enum. All current rows verified as
-- 'not_connected' before applying.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_stripe_account_status'
      AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT chk_stripe_account_status
      CHECK (stripe_account_status IN ('not_connected', 'onboarding', 'active', 'disconnected', 'restricted'));
  END IF;
END$$;

-- The original platform_plan CHECK predates the May 2026 pricing pivot
-- ("Free to start. We earn when you earn.") and doesn't include 'free'.
-- Add 'free' to the allowed list; leave the legacy values in place to avoid
-- breaking any existing rows or future-paid-tier work.
ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_platform_plan_check;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_platform_plan_check
  CHECK (platform_plan IN ('pilot', 'free', 'flat_monthly', 'per_registration', 'hybrid', 'enterprise'));

-- Trigger: block non-admin updates to the locked columns.
-- Bypass for service_role (edge fns), direct DB / migration context, and
-- platform admins.
CREATE OR REPLACE FUNCTION public.guard_organizations_locked_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() IS NULL
     OR auth.role() = 'service_role'
     OR public.is_platform_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.stripe_account_id      IS DISTINCT FROM OLD.stripe_account_id
  OR NEW.platform_fee_card_pct  IS DISTINCT FROM OLD.platform_fee_card_pct
  OR NEW.platform_fee_ach_pct   IS DISTINCT FROM OLD.platform_fee_ach_pct
  OR NEW.platform_fee_cap_cents IS DISTINCT FROM OLD.platform_fee_cap_cents THEN
    RAISE EXCEPTION 'stripe_account_id and platform fee rate columns can only be changed by Enrops platform admins.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_organizations_locked_columns ON organizations;
CREATE TRIGGER guard_organizations_locked_columns
  BEFORE UPDATE ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_organizations_locked_columns();

-- Drop the previous trigger name from an earlier draft of this migration
-- (idempotency-safe; ignored if not present).
DROP TRIGGER IF EXISTS guard_organizations_fee_rates ON organizations;
DROP FUNCTION IF EXISTS public.guard_organizations_fee_rates();

-- NOTE: tenant-specific seed data (J2S free plan, suffix, admin fee) does NOT
-- live in this schema migration. See supabase/seeds/j2s_bootstrap.sql for the
-- one-time J2S configuration. Schema migrations stay tenant-agnostic so a
-- fresh-environment clone doesn't inherit one tenant's preferences as if
-- they were defaults.
