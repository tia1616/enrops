-- Spec D-i, Chunk 1: who bears Stripe's processing fee, per tenant.
-- Additive + behavior-neutral: no code reads this column yet (wired in a later chunk).
--
-- Default 'tenant' = the provider absorbs Stripe's processing fee (like Square /
-- Squarespace already do for them), and Enrops never silently eats it. Legacy
-- own-platform orgs (e.g. J2S) are set to 'platform' so their economics are
-- UNCHANGED. Gated on instructor_pay_model, NOT on any tenant slug.
--
-- Applied to staging 2026-06-29 via MCP; this file keeps repo↔DB in sync. Apply the
-- identical migration to prod in the same pass (parity) on Jessica's explicit go.

ALTER TABLE public.organizations
  ADD COLUMN stripe_fee_payer text NOT NULL DEFAULT 'tenant'
  CONSTRAINT organizations_stripe_fee_payer_check
  CHECK (stripe_fee_payer IN ('tenant','platform','parent'));

UPDATE public.organizations
  SET stripe_fee_payer = 'platform'
  WHERE instructor_pay_model = 'legacy_own_platform';
