-- supabase/seeds/j2s_bootstrap.sql
--
-- One-time configuration for Journey to STEAM (tenant #1, the dogfood tenant)
-- that was previously embedded in 20260527_organizations_stripe_connect_fee_config.sql.
-- Pulled out so the schema migration stays tenant-agnostic.
--
-- This file has already been applied to prod (via the original migration on
-- 2026-05-27). It exists in the repo for:
--   - Reproduction in fresh dev environments
--   - Audit trail of how J2S was configured
--
-- DO NOT add Stripe-Connect-Express output (stripe_account_id, etc.) here.
-- Those are populated by the Express onboarding flow at runtime.
--
-- DO NOT add other tenants here. Each tenant gets their own seed file or,
-- better, captures values via the admin UI at tenant onboarding time.

-- J2S-specific configuration
UPDATE organizations
SET
  platform_plan                 = 'free',
  fee_pass_through              = false,
  withdrawal_admin_fee_cents    = 3500,   -- $35 withdrawal admin fee
  statement_descriptor_suffix   = 'J2S',  -- parents see "ENROPS J2S"
  stripe_business_type          = 'company',
  stripe_country                = 'US'
WHERE id = '1adf10ad-d091-4aa0-82e3-af331468ea2b';
