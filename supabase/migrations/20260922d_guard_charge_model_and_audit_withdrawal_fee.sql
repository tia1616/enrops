-- The two money columns on `organizations` that nothing was watching.
--
-- FOUND 2026-09-22, by the guard test finally being able to run. Neither column
-- has ever actually been changed by an operator; this is a missing lock, not an
-- incident. Both are reachable because members_update_own_org is
-- `FOR UPDATE USING (can_admin_org(id) OR is_platform_admin())` with NO WITH
-- CHECK, so an org admin may write any column on their own row that this
-- trigger does not name.
--
-- 1. stripe_charge_model -- LOCKED AND AUDITED.
-- It decides whose Stripe balance the processing fee comes out of: 'destination'
-- means the platform bears it, 'direct' means the operator does. That is a
-- negotiated platform term, exactly like stripe_fee_payer beside it, and it is
-- not an operator's to set. Real money moves on this value.
--
-- LOCKING IT CANNOT BREAK THE CONNECT FLOW, checked rather than assumed. The
-- guard returns early for `auth.role() = 'service_role'`, and every writer of
-- this column is a service-role edge function: stripe-connect-onboard,
-- stripe-oauth-callback and process-installments. NOTHING in src/ writes it --
-- Finances.jsx only reads it, and its three saves are single-column
-- (fee_pass_through, statement_descriptor_suffix, withdrawal_admin_fee_cents),
-- so no whole-row write drags it along. Read every one of them on 2026-09-22.
--
-- 2. withdrawal_admin_fee_cents -- AUDITED, DELIBERATELY NOT LOCKED.
-- It is typed by the operator on the Finances page and deducted from what a
-- family receives on a refund (J2S has $35 set). That is the provider's own
-- charge to set, like fee_pass_through -- locking it would take away a working
-- control. But it changes what a family gets back, so it must leave a record of
-- who changed it and when. Same treatment as fee_pass_through, for the same
-- reason, and the test asserts BOTH halves so that "fixing" it by locking it
-- fails loudly instead of quietly removing an operator control.
--
-- WHY THE RAISE MESSAGE NAMES THE NEW COLUMN. Until today, a column's mere
-- appearance in this message satisfied the guard test -- so deleting a real lock
-- while leaving the prose behind read as green. That is fixed in the same pass
-- (orgMoneyColumnsGuarded now matches `NEW.<col>`, not the bare name), which is
-- what makes it safe for this message to stay helpful to an operator.
--
-- COPIED FROM pg_get_functiondef ON STAGING, not from an older migration file.
-- Both functions were byte-identical on staging and prod before this ran
-- (guard 2d45cd40..., audit c4e097a2...), so this lands the same change on both.

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
  OR NEW.stripe_fee_payer         IS DISTINCT FROM OLD.stripe_fee_payer
  OR NEW.stripe_charge_model      IS DISTINCT FROM OLD.stripe_charge_model
  OR NEW.instructor_pay_enabled   IS DISTINCT FROM OLD.instructor_pay_enabled
  OR NEW.instructor_pay_model     IS DISTINCT FROM OLD.instructor_pay_model
  OR NEW.platform_plan            IS DISTINCT FROM OLD.platform_plan THEN
    RAISE EXCEPTION 'stripe_account_id, the platform fee rate, floor, cap and end-date columns, stripe_fee_payer, stripe_charge_model, instructor_pay_enabled, instructor_pay_model, and platform_plan can only be changed by Enrops platform admins.'
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
  -- One row per changed column, so a dispute reads as a list of facts rather
  -- than a diff someone has to interpret.
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
