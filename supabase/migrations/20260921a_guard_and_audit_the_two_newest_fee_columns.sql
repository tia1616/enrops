-- The two fee columns added on 2026-09-18 were never added to the guard or the
-- audit, so they are the only money columns an operator can change on their own
-- organisation, and the only ones that change with no record of who did it.
--
-- FOUND 2026-09-21 while setting Jeff's negotiated end date. The point of
-- platform_fee_override_until is that a negotiated rate EXPIRES on a date; but
-- members_update_own_org lets any org admin update their own row, and the guard
-- lists platform_fee_card_pct / ach_pct / cap_cents / floor_cents and stops
-- there. So the operator whose rate expires could move or remove the expiry -
-- which is the whole agreement - and nobody would have a record.
--
-- platform_fee_ach_cap_cents is the same shape and costs real money in the other
-- direction: a null or zero reads as "no bank ceiling" (see computePlatformFee),
-- so an operator could set their own bank fee ceiling to 1c and pay Enrops
-- essentially nothing on every bank payment.
--
-- Neither is reachable by a family; both are reachable by an operator admin.
-- Nothing on production has been changed this way - organization_money_audit is
-- empty of these columns because they were never audited, so the check that
-- matters is the Stripe application fees actually taken, which reconcile.
--
-- Both functions are recreated whole rather than patched, and both keep
-- SECURITY DEFINER with search_path pinned exactly as they had it.

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
  -- The two added 2026-09-18 and missed until 2026-09-21.
  OR NEW.platform_fee_ach_cap_cents  IS DISTINCT FROM OLD.platform_fee_ach_cap_cents
  OR NEW.platform_fee_override_until IS DISTINCT FROM OLD.platform_fee_override_until
  OR NEW.platform_fee_floor_cents IS DISTINCT FROM OLD.platform_fee_floor_cents
  OR NEW.stripe_fee_payer         IS DISTINCT FROM OLD.stripe_fee_payer
  OR NEW.instructor_pay_enabled   IS DISTINCT FROM OLD.instructor_pay_enabled
  OR NEW.instructor_pay_model     IS DISTINCT FROM OLD.instructor_pay_model
  OR NEW.platform_plan            IS DISTINCT FROM OLD.platform_plan THEN
    RAISE EXCEPTION 'stripe_account_id, the platform fee rate, floor, cap and end-date columns, stripe_fee_payer, instructor_pay_enabled, instructor_pay_model, and platform_plan can only be changed by Enrops platform admins.'
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

  -- The two added 2026-09-18 and missed until 2026-09-21. Both change what a
  -- family is charged, so both belong in the record for the same reason the
  -- five above do.
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

  RETURN NEW;
END;
$$;
