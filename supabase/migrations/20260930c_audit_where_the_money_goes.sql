-- stripe_account_id joins the money audit.
--
-- It is the column that says WHERE AN ORG'S MONEY GOES, it has been locked to
-- platform admins since 20260527 for exactly that reason, and until now it was
-- the only locked money column whose changes were recorded nowhere.
--
-- HOW IT WAS FOUND, 2026-09-30: running stripe-complete-move's real promote
-- payload against a staging row and reading the audit trail back. The promote
-- writes three columns - stripe_account_id, stripe_pending_account_id and
-- stripe_charge_model - and produced audit rows for the second and third only.
-- So "this business moved from account A to account B" was the one fact the
-- money trail did not carry.
--
-- WHY NOW. Before prepare-then-switch, stripe_account_id changed once, during
-- onboarding, and an org that had one never got another. The switch turns it
-- into something a platform admin changes deliberately, on a live business,
-- while families are paying. A column like that gets a row naming the old value
-- and the new one.
--
-- WHAT THIS DOES NOT FIX, and it is worth stating: both writers are edge
-- functions holding service_role, and auth.uid() / auth.jwt() are empty there,
-- so changed_by and changed_by_email land NULL exactly as they already do for
-- every other column these functions touch. The audit answers WHAT and WHEN,
-- not WHO. WHO is answered by intelligence.platform_events, which
-- stripe-complete-move writes with the acting admin's user id. Making the audit
-- itself carry the actor means passing it through from the caller, which is a
-- different change with a different blast radius.
--
-- Guard untouched: stripe_account_id was already locked, and this migration
-- does not restate guard_organizations_locked_columns at all.

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

  -- THE NEW ONE. Text like its two neighbours above, so no ::text cast.
  IF NEW.stripe_account_id IS DISTINCT FROM OLD.stripe_account_id THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'stripe_account_id', OLD.stripe_account_id, NEW.stripe_account_id, v_uid, v_email);
  END IF;

  IF NEW.stripe_pending_account_id IS DISTINCT FROM OLD.stripe_pending_account_id THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'stripe_pending_account_id', OLD.stripe_pending_account_id, NEW.stripe_pending_account_id, v_uid, v_email);
  END IF;

  IF NEW.withdrawal_admin_fee_cents IS DISTINCT FROM OLD.withdrawal_admin_fee_cents THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'withdrawal_admin_fee_cents', OLD.withdrawal_admin_fee_cents::text, NEW.withdrawal_admin_fee_cents::text, v_uid, v_email);
  END IF;

  RETURN NEW;
END;
$$;
