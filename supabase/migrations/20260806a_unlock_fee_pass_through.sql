-- 20260806a_unlock_fee_pass_through.sql
--
-- Give operators back the pass-through toggle.
--
-- WHAT WAS BROKEN. The "Who pays the enrops service fee?" toggle on Payments
-- rendered for every operator, fired, and was then rejected by
-- guard_organizations_locked_columns with SQLSTATE 42501. Only the two rows in
-- platform_admins (jessica@journeytosteam.com, arielle@enrops.com) could change
-- it, so for every actual tenant it was a dead control: it flipped, reverted,
-- and printed a list of database column names at the top of the page.
--
-- Reproduced on staging under real RLS as riverbend's actual owner
-- (auth_user_id 6d25b46c-a90e-4a90-8c2d-1a551b171efd, is_platform_admin() =
-- false), not inferred from the trigger body:
--     ERROR 42501 ... guard_organizations_locked_columns() line 18 at RAISE
--
-- WHY THIS IS A REGRESSION AND NOT A DECISION. fee_pass_through was designed to
-- be operator-editable and is still documented that way in two places:
--   - 20260527_organizations_stripe_connect_fee_config.sql lists it FIRST under
--     "UNLOCKED columns (org owner/admin can edit freely via Finances tab)";
--   - the live column comment on prod today still reads "...Editable by org
--     owner/admin via Finances tab toggle."
-- It entered the locked list out-of-band between 20260703 and 20260801c. That
-- second migration's own header says it reproduced the live function "exactly so
-- this is only the one branch being added" for sending_domain - so it inherited
-- the lock rather than choosing it. No migration ever argues for locking it.
--
-- WHY IT IS SAFE TO UNLOCK - this is the part that matters for money.
-- fee_pass_through does NOT change what Enrops earns. The Stripe Connect
-- application_fee_amount is computed by computePlatformFee from the RATE columns
-- (card/ach pct, floor, cap), all of which stay locked. fee_pass_through only
-- decides who bears that same fee:
--   true  -> the family pays base + fee as a separate line; operator nets base.
--   false -> the family pays base; the fee comes out of the operator's payout.
-- Either way Enrops collects the identical application fee. So this is the
-- operator's own pricing decision about their own customers, which is exactly
-- why the original design left it unlocked. Every genuine platform money lever
-- (the rate columns, stripe_fee_payer, stripe_account_id, instructor_pay_*) is
-- untouched and stays platform-admin-only.
--
-- The one real consequence, handled in the UI rather than here: computePlatformFee
-- reads live org config with no snapshot, so toggling mid-term reprices the
-- REMAINING installments of an in-flight plan (see 20260626_fee_pass_through_wiring
-- "operators are told not to toggle mid-term"). The Payments toggle now warns when
-- the org has unpaid installments instead of relying on that instruction.
--
-- Reproduced exactly from the LIVE function (read via pg_get_functiondef on both
-- prod and staging, byte-compared against 20260801c) with ONE line removed: the
-- fee_pass_through comparison. Everything else is unchanged, including:
--   - the sending_domain branch and its message, verbatim;
--   - the absence of `set search_path`. That is a pre-existing advisor warning on
--     this function, deliberately left alone by 20260801c for the same reason it
--     is left alone here: pinning it is a security change unrelated to this
--     capability fix, and bundling them means a revert of one reverts the other.
--     Tracked separately, NOT fixed by this migration.
--
-- fee_pass_through is removed from the message too - listing a column that is no
-- longer locked would send an operator hunting for a restriction that is gone.

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
  OR NEW.stripe_fee_payer         IS DISTINCT FROM OLD.stripe_fee_payer
  OR NEW.instructor_pay_enabled   IS DISTINCT FROM OLD.instructor_pay_enabled
  OR NEW.instructor_pay_model     IS DISTINCT FROM OLD.instructor_pay_model THEN
    RAISE EXCEPTION 'stripe_account_id, platform fee rate columns, stripe_fee_payer, instructor_pay_enabled, and instructor_pay_model can only be changed by Enrops platform admins.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.sending_domain IS DISTINCT FROM OLD.sending_domain THEN
    RAISE EXCEPTION 'sending_domain records a Resend-verified sending domain and can only be set by Enrops once verification passes. Ask Enrops to set up a custom sending domain; until then your email sends from your own address on the shared Enrops domain.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
