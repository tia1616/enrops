-- 20260528_drop_old_stripe_account_status_check.sql
--
-- Bug fix during J2S Connect dogfood test on 2026-05-28.
--
-- The organizations table had TWO competing CHECK constraints on
-- stripe_account_status:
--   - organizations_stripe_account_status_check (pre-existing): allowed
--     'not_connected', 'pending', 'active', 'restricted', 'disabled'
--   - chk_stripe_account_status (added in
--     20260527_organizations_stripe_connect_fee_config.sql): allowed
--     'not_connected', 'onboarding', 'active', 'disconnected', 'restricted'
--
-- The old constraint used 'pending'/'disabled' vocabulary; the new one uses
-- 'onboarding'/'disconnected' to match the Express Connect lifecycle. Both
-- being present meant any insert/update with the new states violated the
-- old constraint — including the stripe-connect-onboard edge function
-- writing 'onboarding' after creating the Express account. The function
-- returned 'persist_failed' and deleted the just-created Stripe account.
--
-- Drop the old constraint; chk_stripe_account_status alone now governs the
-- column.

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_stripe_account_status_check;
