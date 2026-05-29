-- 20260528_instructor_pay_model_dispatch.sql
--
-- Adds the dispatch column that lets pay-instructor and the instructor
-- onboarding flow route to one of two architectures per tenant:
--
--   'legacy_own_platform' — operator runs their own Stripe Connect platform
--                           (the J2S model, pre-existing from before Enrops).
--                           STRIPE_INSTRUCTOR_PLATFORM_KEY env var points
--                           to that platform. Instructors are Express
--                           accounts under it.
--
--   'enrops_platform'     — Enrops is THE platform for instructor pay.
--                           Instructors are Express accounts under Enrops's
--                           Stripe (the same platform that hosts the
--                           operator's Receivables connected account).
--                           pay-instructor uses stripe.transfers.create
--                           with a stripeAccount header to act on behalf
--                           of the operator's connected account — money
--                           moves from operator's balance to instructor's
--                           balance, both under Enrops.
--
-- Default for new tenants: 'enrops_platform'. Self-serve. No operator-side
-- platform setup, no developer key handoff. Tenant signs up, connects
-- Stripe for Receivables (already self-serve), invites instructors via
-- the contractor portal — instructors onboard under Enrops's platform —
-- payroll works.
--
-- J2S is seeded 'legacy_own_platform' via supabase/seeds/j2s_bootstrap.sql.
-- J2S's existing instructors stay where they are (no re-onboarding).
--
-- The column is locked via guard_organizations_locked_columns trigger so
-- only Enrops platform admins can change it — flipping it mid-flight
-- would orphan all the org's existing instructor connected accounts on
-- the wrong platform.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS instructor_pay_model TEXT NOT NULL DEFAULT 'enrops_platform'
  CHECK (instructor_pay_model IN ('legacy_own_platform', 'enrops_platform'));

COMMENT ON COLUMN organizations.instructor_pay_model IS
  'Routing key for instructor pay architecture. ''enrops_platform'' (default, self-serve): instructors are Express accounts under Enrops''s Stripe Connect platform; pay routes via stripe.transfers.create acting on operator''s connected account. ''legacy_own_platform'' (J2S only): operator owns their own Stripe Connect platform; STRIPE_INSTRUCTOR_PLATFORM_KEY env points to it; pay routes via that platform''s balance. LOCKED to platform admins via guard_organizations_locked_columns trigger — flipping orphans existing instructor accounts.';

-- Extend the existing locked-columns guard to cover instructor_pay_model.
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

  IF NEW.stripe_account_id        IS DISTINCT FROM OLD.stripe_account_id
  OR NEW.platform_fee_card_pct    IS DISTINCT FROM OLD.platform_fee_card_pct
  OR NEW.platform_fee_ach_pct     IS DISTINCT FROM OLD.platform_fee_ach_pct
  OR NEW.platform_fee_cap_cents   IS DISTINCT FROM OLD.platform_fee_cap_cents
  OR NEW.instructor_pay_enabled   IS DISTINCT FROM OLD.instructor_pay_enabled
  OR NEW.instructor_pay_model     IS DISTINCT FROM OLD.instructor_pay_model THEN
    RAISE EXCEPTION 'stripe_account_id, platform fee rate columns, instructor_pay_enabled, and instructor_pay_model can only be changed by Enrops platform admins.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
