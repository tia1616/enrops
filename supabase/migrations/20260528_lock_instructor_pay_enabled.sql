-- 20260528_lock_instructor_pay_enabled.sql
--
-- Extend the existing guard_organizations_locked_columns trigger to also
-- lock `instructor_pay_enabled`. Without this lock, any org owner/admin
-- could flip the flag on their own org via supabase-js and trigger
-- pay-instructor, which would drain J2S's instructor-pay Stripe platform
-- (the shared STRIPE_INSTRUCTOR_PLATFORM_KEY).
--
-- The circuit breaker is only safe if it can only be flipped by Enrops
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

  IF NEW.stripe_account_id        IS DISTINCT FROM OLD.stripe_account_id
  OR NEW.platform_fee_card_pct    IS DISTINCT FROM OLD.platform_fee_card_pct
  OR NEW.platform_fee_ach_pct     IS DISTINCT FROM OLD.platform_fee_ach_pct
  OR NEW.platform_fee_cap_cents   IS DISTINCT FROM OLD.platform_fee_cap_cents
  OR NEW.instructor_pay_enabled   IS DISTINCT FROM OLD.instructor_pay_enabled THEN
    RAISE EXCEPTION 'stripe_account_id, platform fee rate columns, and instructor_pay_enabled can only be changed by Enrops platform admins.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
