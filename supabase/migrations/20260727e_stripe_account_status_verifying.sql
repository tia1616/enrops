-- 20260727e — add a 'verifying' organizations.stripe_account_status.
--
-- WHY. Stripe's disabled_reason is not one thing. 'requirements.past_due' means
-- the operator genuinely owes information. 'requirements.pending_verification'
-- (and 'under_review') mean the OPPOSITE: everything has been submitted,
-- requirements.currently_due is EMPTY, and Stripe is simply reviewing.
--
-- stripe-webhook collapsed every disabled_reason into 'restricted', and the
-- Finances screen renders 'restricted' as "Stripe has paused some of your
-- account capabilities. You'll usually fix this by providing additional info".
-- Observed live on 2026-07-27: an operator who had completed onboarding
-- perfectly was told to go supply information Stripe was not asking for, with a
-- "Continue setup" button that would have taken them back into a finished form.
-- The account cleared on its own about a minute later.
--
-- That is a dishonest-state bug on a money surface: the screen said "do
-- something" when the true answer was "nothing to do, wait a minute". A sixth
-- value lets the UI say that instead of guessing.
--
-- Additive and inert: nothing writes 'verifying' until the updated
-- stripe-webhook / sync-operator-stripe-status ship, and no existing row
-- changes. Widening a CHECK constraint cannot invalidate existing rows.

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS chk_stripe_account_status;

ALTER TABLE public.organizations
  ADD CONSTRAINT chk_stripe_account_status
  CHECK (stripe_account_status = ANY (ARRAY[
    'not_connected'::text,
    'onboarding'::text,
    'verifying'::text,
    'active'::text,
    'disconnected'::text,
    'restricted'::text
  ]));

COMMENT ON COLUMN public.organizations.stripe_account_status IS
  'not_connected = never connected. onboarding = form not finished. verifying = everything submitted, Stripe is reviewing, NOTHING is required from the operator. active = charges + payouts on. restricted = Stripe disabled the account for a reason the operator must act on. disconnected = operator revoked access.';
