-- Record WHICH Stripe money model an org is on. Additive and inert: every
-- existing row defaults to 'destination', which is exactly what they run today,
-- so nothing changes until Phase 2 teaches the charge path to branch on it.
--
-- WHY A NEW COLUMN INSTEAD OF REUSING stripe_fee_payer
-- stripe_fee_payer ('tenant' | 'platform') is OUR concept: it decides whether we
-- add the uplift that recovers Stripe's processing fee inside the application
-- fee. It is not Stripe's controller.fees.payer. Overloading it would conflate
-- "who we bill for the fee" with "who Stripe bills", which is the exact
-- confusion that made Arielle's refund spec describe a platform we don't run.
--
-- 'destination'  = Express account, transfer_data.destination, ENROPS pays
--                  Stripe's fee and carries dispute liability, uplift recovers
--                  the fee inside the application fee. J2S and the two test
--                  orgs. Verified against real balance transactions 2026-07-24.
-- 'direct'       = controller-based account (Standard-equivalent), charge
--                  created ON the connected account, the OPERATOR pays Stripe's
--                  fee natively and carries dispute liability, and our
--                  application fee is clean margin with no uplift.
--
-- Per Stripe's API reference the `type` parameter is deprecated in favour of
-- `controller`, whose defaults are already the model Arielle specced:
-- fees.payer=account, losses.payments=stripe, stripe_dashboard.type=full.
-- We set all three EXPLICITLY at creation rather than relying on defaults,
-- because none of them can ever be changed on an account afterwards.
--
-- J2S NEVER MOVES. It is mid-FA26 with 80 open programs and 91 real paid
-- registrations; it stays 'destination' indefinitely.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS stripe_charge_model text NOT NULL DEFAULT 'destination';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_stripe_charge_model_check'
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_stripe_charge_model_check
      CHECK (stripe_charge_model IN ('destination', 'direct'));
  END IF;
END $$;

COMMENT ON COLUMN public.organizations.stripe_charge_model IS
  'destination = legacy Express + transfer_data (platform pays Stripe fee, platform bears disputes, uplift applies). direct = controller-based account, charge created on the connected account (operator pays Stripe fee, operator bears disputes, no uplift). Set at account creation and never changed - Stripe fixes controller.fees.payer at account creation.';
