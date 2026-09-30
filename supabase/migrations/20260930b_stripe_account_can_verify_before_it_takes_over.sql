-- A new Stripe account can finish verification BEFORE it starts taking the money.
--
-- THE PROBLEM THIS EXISTS FOR. stripe-connect-onboard mints an Express account
-- and, in the SAME write, points organizations.stripe_account_id at it and sets
-- stripe_charge_model='direct'. buildChargeRouting then fails closed on
-- 'direct' + stripe_charges_enabled=false (connectChargeParams.ts) - so from the
-- instant the account is created until Stripe finishes verifying it, checkout is
-- refused. Minutes, or days; Stripe does not say which.
--
-- For a brand new operator that costs nothing: they have nothing on sale yet, and
-- the row self-heals when stripe-webhook receives account.updated. It only bites
-- an org that is ALREADY selling and has to move to a different account - which
-- is exactly item 12 (J2S to direct charges), where the existing account cannot
-- be reused because its fee-payer is fixed at 'application_express' and Stripe
-- does not allow that to change on an account that already exists.
--
-- So: somewhere for the new account to WAIT. stripe_pending_account_id holds an
-- account that exists at Stripe and is being verified, while every charge keeps
-- routing to the account in stripe_account_id. Nothing switches until a platform
-- admin switches it, and the switch can refuse if Stripe still cannot take
-- charges on the new account.
--
-- INERT ON ARRIVAL. Nothing reads this column yet: no edge function, no query, no
-- UI. It is nullable with no default and every existing row keeps NULL, so no
-- charge, refund, payout or save path can behave differently because it exists.
-- The writers come in the next chunk.
--
-- WHY IT IS LOCKED AND AUDITED like stripe_account_id beside it. This column is
-- one write away from being the payout destination, and members_update_own_org is
-- FOR UPDATE USING (...) with NO WITH CHECK - so any column the guard does not
-- refuse is writable by an org admin on their own org. An operator who could
-- stage an arbitrary acct_ID here would only need the switch to run to redirect
-- their org's money. Same reasoning as the 20260527 "payout-theft prevention"
-- lock on stripe_account_id, and the same treatment.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS stripe_pending_account_id text;

COMMENT ON COLUMN public.organizations.stripe_pending_account_id IS
  'A Stripe connected account that exists and is being verified, but is NOT yet taking this org''s money. Charges keep routing to stripe_account_id until a platform admin promotes this one. NULL = no move in progress. Platform-admin only, audited.';

-- Guard: unchanged except for the one new column and the message naming it.
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
  OR NEW.stripe_pending_account_id IS DISTINCT FROM OLD.stripe_pending_account_id
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
    RAISE EXCEPTION 'stripe_account_id, stripe_pending_account_id, the platform fee rate, floor, cap and end-date columns, the platform plan price columns, stripe_fee_payer, stripe_charge_model, instructor_pay_enabled, instructor_pay_model, and platform_plan can only be changed by Enrops platform admins.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.sending_domain IS DISTINCT FROM OLD.sending_domain THEN
    RAISE EXCEPTION 'sending_domain records a Resend-verified sending domain and can only be set by Enrops once verification passes. Ask Enrops to set up a custom sending domain; until then your email sends from your own address on the shared Enrops domain.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- Audit: unchanged except for the one new column.
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
