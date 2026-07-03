-- Lock stripe_fee_payer against operator edits (Enrops money lever).
--
-- Context: guard_organizations_locked_columns() already blocks non-platform-admins
-- from changing the platform fee-rate columns, stripe_account_id, and instructor_pay_*.
-- stripe_fee_payer was NOT in that list. It controls who bears Stripe's processing
-- fee: connectChargeParams only recovers the Stripe fee when stripe_fee_payer='tenant'
-- (stripeRecovery = stripe_fee_payer === 'tenant' ? estimateStripeFee(...) : 0), so an
-- org admin who flipped their own row to 'platform' via a direct API call (RLS
-- members_update_own_org allows updating your own org, and there is no WITH CHECK /
-- column restriction) would shift Stripe's ~2.9% card fee onto Enrops's platform
-- balance. This adds stripe_fee_payer to the locked set so only Enrops platform
-- admins / service_role may change it.
--
-- Idempotent (CREATE OR REPLACE). Applied directly to prod (iuasfpztkmrtagivlhtj)
-- and staging (mumfymlapolsfdnpewci) on 2026-07-03 via MCP; this file records it in
-- source control for parity/replay. Verified on staging by simulating a real org
-- owner (non-platform-admin) UPDATE, which was rejected with SQLSTATE 42501.

CREATE OR REPLACE FUNCTION public.guard_organizations_locked_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  OR NEW.stripe_fee_payer         IS DISTINCT FROM OLD.stripe_fee_payer
  OR NEW.instructor_pay_enabled   IS DISTINCT FROM OLD.instructor_pay_enabled
  OR NEW.instructor_pay_model     IS DISTINCT FROM OLD.instructor_pay_model THEN
    RAISE EXCEPTION 'stripe_account_id, platform fee rate columns, stripe_fee_payer, instructor_pay_enabled, and instructor_pay_model can only be changed by Enrops platform admins.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;
