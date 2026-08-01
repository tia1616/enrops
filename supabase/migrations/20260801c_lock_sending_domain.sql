-- 20260801c_lock_sending_domain.sql
--
-- Make organizations.sending_domain platform-admin-only.
--
-- WHY, and this is the load-bearing part of the sender fix:
-- loadOrgBrand() sends from a tenant's OWN address only when that address's
-- domain equals organizations.sending_domain. The whole safety argument is
-- "sending_domain means Resend has verified this domain". Nothing enforced the
-- second half. Proven on staging under real RLS (set_config role=authenticated
-- + jwt claims as the org owner): an owner could UPDATE sending_domain to any
-- string they liked. Set it to a domain they do not control, point
-- default_sender_email at the same domain, and loadOrgBrand honours it - which
-- puts that org straight back into the exact silent failure this pass removes:
--
--   403 validation_error: "The <domain> domain is not verified. Please, add and
--   verify your domain on https://resend.com/domains"
--
-- (that is a real response captured from Resend on staging, not a hypothetical).
--
-- Verifying a domain is a platform operation - it needs DNS records added and
-- confirmed in Resend - so the column that records the RESULT of that operation
-- should not be operator-writable.
--
-- ZERO operator impact: nothing writes this column today. No page under src/
-- reads or writes it, and no edge function writes it (orgBrand.ts only SELECTs
-- it). The only writers have ever been platform SQL, which runs as service_role
-- and is exempt from the guard below. So this closes the hole without taking a
-- capability away from anyone.
--
-- Additive to the EXISTING guard rather than a new trigger, so there is still
-- one place that answers "which columns are platform-only".

-- Name, language and prosecdef read off the LIVE function, not guessed: it is
-- public.guard_organizations_locked_columns (same name as the trigger),
-- plpgsql, SECURITY DEFINER, with NO `set search_path` in proconfig. All three
-- are reproduced exactly so this is only the one branch being added. (The
-- missing search_path is a pre-existing advisor warning on this function; left
-- alone deliberately - changing it here would be an unrelated behaviour change
-- riding along in an email fix.)
create or replace function public.guard_organizations_locked_columns()
returns trigger
language plpgsql
security definer
as $$
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
  OR NEW.platform_fee_floor_cents IS DISTINCT FROM OLD.platform_fee_floor_cents
  OR NEW.fee_pass_through         IS DISTINCT FROM OLD.fee_pass_through
  OR NEW.stripe_fee_payer         IS DISTINCT FROM OLD.stripe_fee_payer
  OR NEW.instructor_pay_enabled   IS DISTINCT FROM OLD.instructor_pay_enabled
  OR NEW.instructor_pay_model     IS DISTINCT FROM OLD.instructor_pay_model THEN
    RAISE EXCEPTION 'stripe_account_id, platform fee columns, fee_pass_through, stripe_fee_payer, instructor_pay_enabled, and instructor_pay_model can only be changed by Enrops platform admins.'
      USING ERRCODE = '42501';
  END IF;

  -- NEW: sending_domain records that Enrops verified this domain in Resend.
  -- Separate branch and separate message so an operator who somehow hits it is
  -- told what to actually do, rather than reading a list of Stripe fee columns
  -- that has nothing to do with email.
  IF NEW.sending_domain IS DISTINCT FROM OLD.sending_domain THEN
    RAISE EXCEPTION 'sending_domain records a Resend-verified sending domain and can only be set by Enrops once verification passes. Ask Enrops to set up a custom sending domain; until then your email sends from your own address on the shared Enrops domain.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
