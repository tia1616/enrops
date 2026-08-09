-- Lock platform_plan against operator edits, and stop NULL slipping past its CHECK.
--
-- WHY THIS EXISTS: 20260809a made platform_plan load-bearing. src/lib/entitlements.js
-- resolves what an org can reach from it, which turned a decorative label into an
-- access-control input. The entitlement decision used to sit on instructor_pay_model,
-- which IS in this guard; moving it to platform_plan moved it OUT of the guard without
-- anyone noticing.
--
-- THE HOLE (verified on live prod before writing this):
--   * guard_organizations_locked_columns() did not mention platform_plan
--   * RLS members_update_own_org is FOR UPDATE USING (can_admin_org(id) OR
--     is_platform_admin()) with NO with-check expression
--   * `authenticated` holds a table-level UPDATE grant on public.organizations, with
--     no column-level narrowing anywhere in migration history
--   * every self-serve signup mints its own `owner` row, so can_admin_org(id) is true
--     for your own org
-- Net: any operator could run
--   update organizations set platform_plan='founding' where id = <their own org>
-- from the browser console and hand themselves the paid Comms tier permanently.
-- A WITH CHECK of the usual can_admin_org(id) shape would NOT have closed this - the
-- row's id is unchanged, so such a check passes.
--
-- Exact precedent: 20260703_lock_stripe_fee_payer_in_org_guard.sql, which closed this
-- identical attack on stripe_fee_payer.
--
-- BUILT FROM THE LIVE FUNCTION BODY, NOT FROM THAT FILE. The deployed definition has
-- moved on since 20260703: it also guards platform_fee_floor_cents and sending_domain
-- (the latter with its own message). CREATE OR REPLACE from the older file would have
-- silently DROPPED both of those guards while appearing to add one. The body below is
-- the live one plus platform_plan.
--
-- SECOND FIX, same column: the CHECK added by 20260809a cannot reject NULL. A CHECK
-- only fails on FALSE and `NULL IN (...)` evaluates to NULL, so a NULL plan passed.
-- FULL_ACCESS_PLANS.has(null) is false, so a founding org whose plan was nulled would
-- silently drop to the bare tier with no database error - the same fail-closed-and-
-- quiet shape as the AdminLayout select bug, arriving by the data path instead.
-- Verified before applying: 0 NULL rows on prod (7 orgs) and staging (8 orgs), so
-- tightening invalidates nothing.
--
-- Additive and inert: no row changes, no value moves. Applied to staging AND prod in
-- the same pass.

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
  OR NEW.platform_fee_floor_cents IS DISTINCT FROM OLD.platform_fee_floor_cents
  OR NEW.stripe_fee_payer         IS DISTINCT FROM OLD.stripe_fee_payer
  OR NEW.instructor_pay_enabled   IS DISTINCT FROM OLD.instructor_pay_enabled
  OR NEW.instructor_pay_model     IS DISTINCT FROM OLD.instructor_pay_model
  OR NEW.platform_plan            IS DISTINCT FROM OLD.platform_plan THEN
    RAISE EXCEPTION 'stripe_account_id, the platform fee rate, floor and cap columns, stripe_fee_payer, instructor_pay_enabled, instructor_pay_model, and platform_plan can only be changed by Enrops platform admins.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.sending_domain IS DISTINCT FROM OLD.sending_domain THEN
    RAISE EXCEPTION 'sending_domain records a Resend-verified sending domain and can only be set by Enrops once verification passes. Ask Enrops to set up a custom sending domain; until then your email sends from your own address on the shared Enrops domain.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_platform_plan_check;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_platform_plan_check
  CHECK (
    platform_plan IS NOT NULL
    AND platform_plan IN (
      'pilot',
      'free',
      'flat_monthly',
      'per_registration',
      'hybrid',
      'enterprise',
      'founding'
    )
  );
