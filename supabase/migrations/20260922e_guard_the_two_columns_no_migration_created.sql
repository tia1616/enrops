-- platform_fee_cents and platform_monthly_cents: money columns on
-- `organizations` that exist on BOTH databases and appear in NO MIGRATION.
--
-- HOW THEY WERE FOUND, 2026-09-22, and it is the useful part. The guard test was
-- rewritten the same day to derive its column list from the migrations, on the
-- reasoning that the schema cannot be forgotten the way a hand-kept constant
-- can. Comparing that scan against information_schema on the live databases
-- found two columns it could never see, because they were applied straight to
-- the database and no file records them. A scan of the repo is a scan of the
-- repo, not of the schema -- so the test now carries them in an explicit
-- ON_DB_BUT_NOT_IN_ANY_MIGRATION list, with the query to re-check it.
--
-- BOTH ARE PLATFORM PRICING TERMS, so both are locked and audited, exactly like
-- platform_plan beside them. platform_monthly_cents is the monthly plan price
-- (9900 = the $99/mo founding-member rate, per the comment in
-- src/lib/entitlements.js); platform_fee_cents is a flat per-registration fee.
--
-- LOCKING THEM IS INERT. Nothing in src/ or supabase/functions/ reads or writes
-- either column -- the only mention anywhere is a code COMMENT -- and the guard
-- returns early for service_role regardless. Both default to 0 and every row on
-- prod carries a value, so no save path can be broken by refusing a change
-- nobody makes. They are locked because they are money, not because anything is
-- currently at risk.
--
-- This also writes the FIRST migration record of these two columns' existence,
-- which is worth more than the lock: until today they were invisible to anyone
-- reading the repo.

CREATE OR REPLACE FUNCTION public.guard_organizations_locked_columns()
RETURNS trigger
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
  OR NEW.platform_fee_ach_cap_cents  IS DISTINCT FROM OLD.platform_fee_ach_cap_cents
  OR NEW.platform_fee_override_until IS DISTINCT FROM OLD.platform_fee_override_until
  OR NEW.platform_fee_floor_cents IS DISTINCT FROM OLD.platform_fee_floor_cents
  OR NEW.platform_fee_cents       IS DISTINCT FROM OLD.platform_fee_cents
  OR NEW.platform_monthly_cents   IS DISTINCT FROM OLD.platform_monthly_cents
  OR NEW.stripe_fee_payer         IS DISTINCT FROM OLD.stripe_fee_payer
  OR NEW.stripe_charge_model      IS DISTINCT FROM OLD.stripe_charge_model
  OR NEW.instructor_pay_enabled   IS DISTINCT FROM OLD.instructor_pay_enabled
  OR NEW.instructor_pay_model     IS DISTINCT FROM OLD.instructor_pay_model
  OR NEW.platform_plan            IS DISTINCT FROM OLD.platform_plan THEN
    RAISE EXCEPTION 'stripe_account_id, the platform fee rate, floor, cap and end-date columns, the platform plan price columns, stripe_fee_payer, stripe_charge_model, instructor_pay_enabled, instructor_pay_model, and platform_plan can only be changed by Enrops platform admins.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.sending_domain IS DISTINCT FROM OLD.sending_domain THEN
    RAISE EXCEPTION 'sending_domain records a Resend-verified sending domain and can only be set by Enrops once verification passes. Ask Enrops to set up a custom sending domain; until then your email sends from your own address on the shared Enrops domain.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.audit_organization_money()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_email text := nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '');
BEGIN
  IF NEW.fee_pass_through IS DISTINCT FROM OLD.fee_pass_through THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'fee_pass_through', OLD.fee_pass_through::text, NEW.fee_pass_through::text, v_uid, v_email);
  END IF;

  IF NEW.platform_fee_card_pct IS DISTINCT FROM OLD.platform_fee_card_pct THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'platform_fee_card_pct', OLD.platform_fee_card_pct::text, NEW.platform_fee_card_pct::text, v_uid, v_email);
  END IF;

  IF NEW.platform_fee_ach_pct IS DISTINCT FROM OLD.platform_fee_ach_pct THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'platform_fee_ach_pct', OLD.platform_fee_ach_pct::text, NEW.platform_fee_ach_pct::text, v_uid, v_email);
  END IF;

  IF NEW.platform_fee_floor_cents IS DISTINCT FROM OLD.platform_fee_floor_cents THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'platform_fee_floor_cents', OLD.platform_fee_floor_cents::text, NEW.platform_fee_floor_cents::text, v_uid, v_email);
  END IF;

  IF NEW.platform_fee_cap_cents IS DISTINCT FROM OLD.platform_fee_cap_cents THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'platform_fee_cap_cents', OLD.platform_fee_cap_cents::text, NEW.platform_fee_cap_cents::text, v_uid, v_email);
  END IF;

  IF NEW.platform_fee_ach_cap_cents IS DISTINCT FROM OLD.platform_fee_ach_cap_cents THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'platform_fee_ach_cap_cents', OLD.platform_fee_ach_cap_cents::text, NEW.platform_fee_ach_cap_cents::text, v_uid, v_email);
  END IF;

  IF NEW.platform_fee_override_until IS DISTINCT FROM OLD.platform_fee_override_until THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'platform_fee_override_until', OLD.platform_fee_override_until::text, NEW.platform_fee_override_until::text, v_uid, v_email);
  END IF;

  IF NEW.platform_fee_cents IS DISTINCT FROM OLD.platform_fee_cents THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'platform_fee_cents', OLD.platform_fee_cents::text, NEW.platform_fee_cents::text, v_uid, v_email);
  END IF;

  IF NEW.platform_monthly_cents IS DISTINCT FROM OLD.platform_monthly_cents THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'platform_monthly_cents', OLD.platform_monthly_cents::text, NEW.platform_monthly_cents::text, v_uid, v_email);
  END IF;

  IF NEW.stripe_fee_payer IS DISTINCT FROM OLD.stripe_fee_payer THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'stripe_fee_payer', OLD.stripe_fee_payer, NEW.stripe_fee_payer, v_uid, v_email);
  END IF;

  IF NEW.stripe_charge_model IS DISTINCT FROM OLD.stripe_charge_model THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'stripe_charge_model', OLD.stripe_charge_model, NEW.stripe_charge_model, v_uid, v_email);
  END IF;

  IF NEW.withdrawal_admin_fee_cents IS DISTINCT FROM OLD.withdrawal_admin_fee_cents THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'withdrawal_admin_fee_cents', OLD.withdrawal_admin_fee_cents::text, NEW.withdrawal_admin_fee_cents::text, v_uid, v_email);
  END IF;

  RETURN NEW;
END;
$$;
