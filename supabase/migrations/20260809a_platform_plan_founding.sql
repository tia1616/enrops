-- Adds 'founding' to the platform_plan CHECK constraint.
--
-- WHY: 'founding' is the early-partner plan (full product access on an agreed
-- free period, then a flat monthly). Until now the only thing distinguishing
-- what an org could DO was instructor_pay_model, which is a NAV-SHAPE fact, not
-- an entitlement one -- so "give this one partner more than the standard lean
-- tier" had no answer that wasn't a hardcoded tenant check. src/lib/
-- entitlements.js reads platform_plan instead, which makes the next founding
-- partner a one-row UPDATE rather than a code change.
--
-- ADDITIVE AND INERT: widening a CHECK cannot invalidate an existing row (every
-- current value stays legal), and no org is moved onto the new plan here. The
-- go-live is a deliberate, reversible UPDATE of a single org's platform_plan
-- AFTER the frontend is on prod -- so prod behaviour is unchanged by this file.
--
-- Deliberately NOT modelled: the plan's end date. There is no subscription
-- billing in the platform yet, so an automatic expiry would silently strip
-- Comms from a live operator mid-term and stop their families' emails. Expiry
-- is a human decision, not a cron.

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_platform_plan_check;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_platform_plan_check
  CHECK (platform_plan IN (
    'pilot',
    'free',
    'flat_monthly',
    'per_registration',
    'hybrid',
    'enterprise',
    'founding'
  ));
