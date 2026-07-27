-- 20260727d — record WHICH Stripe account each charge was actually made on.
--
-- WHY. organizations.stripe_charge_model (20260727c) describes an org RIGHT NOW.
-- Phase 2 code was reading it as if it described the CHARGE, which is wrong the
-- moment an org moves between models — and moving orgs is the entire point of
-- the migration. Per the Phase 1 finding, controller.fees.payer can never be
-- changed on an existing account, so an operator switching to direct charges
-- gets a BRAND NEW connected account. Their older PaymentIntents stay on the
-- platform forever.
--
-- Two concrete failures this prevents (both found in code review):
--   * refund-registration scoped the refund by the org's CURRENT model, so
--     after a flip every pre-flip refund 502s — Stripe cannot find that pi_...
--     on the new connected account, and nothing recorded where it really lived.
--   * checkout-session-status did the same for Checkout Sessions, and its
--     catch-all fails OPEN to {paid:true} — so a family revisiting an older
--     success URL (a bookmark, or an ACH payer checking whether their transfer
--     cleared) would be shown a settled payment that may not have settled.
--
-- SEMANTICS. stripe_charge_account_id IS NULL means the charge lives on the
-- PLATFORM account (every destination charge, i.e. J2S and every org that
-- exists today). Non-null is the connected account the charge was created on.
-- NULL is therefore already correct for all existing rows: additive, inert, and
-- no backfill. Nothing reads these columns until the code that writes them ships.
--
-- registrations.stripe_checkout_session_id lets checkout-session-status resolve
-- the right scope from OUR OWN row instead of a client-supplied org_slug hint,
-- which removes client input from that path entirely.

ALTER TABLE public.registrations
  ADD COLUMN IF NOT EXISTS stripe_charge_account_id text,
  ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text;

ALTER TABLE public.installments
  ADD COLUMN IF NOT EXISTS stripe_charge_account_id text;

COMMENT ON COLUMN public.registrations.stripe_charge_account_id IS
  'Stripe account the charge was created on. NULL = the platform account (destination charge). Non-null = the connected account (direct charge). Records where the money actually went, so refunds do not depend on the org''s current stripe_charge_model.';

COMMENT ON COLUMN public.registrations.stripe_checkout_session_id IS
  'Checkout Session id for this registration, written at session creation. Lets checkout-session-status resolve the correct Stripe account scope server-side, with no client-supplied hint.';

COMMENT ON COLUMN public.installments.stripe_charge_account_id IS
  'Stripe account this installment''s PaymentIntent was created on. NULL = platform (destination charge). Same semantics as registrations.stripe_charge_account_id.';

-- checkout-session-status looks a registration up by session id on an anon,
-- family-facing path, so it needs to be indexed. Partial: only rows that
-- actually went through Stripe Checkout carry a session id.
CREATE INDEX IF NOT EXISTS registrations_stripe_checkout_session_id_idx
  ON public.registrations (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
