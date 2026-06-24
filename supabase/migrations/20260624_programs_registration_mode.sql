-- Per-program registration mode.
--
-- A program is either run by the provider through Enrops (default — public
-- catalog + Stripe checkout) or run by the partner/venue themselves (the
-- program is live, gets matched/scheduled, shows on rosters and the calendar,
-- but is NEVER shown in the public catalog with a checkout).
--
-- Additive + default-preserving: every existing program becomes
-- registration_mode='enrops', so behavior is unchanged until a program is
-- explicitly created as 'partner'. No RLS change — columns inherit the
-- existing programs row policies.

ALTER TABLE public.programs
  ADD COLUMN IF NOT EXISTS registration_mode text NOT NULL DEFAULT 'enrops',
  ADD COLUMN IF NOT EXISTS external_registration_url text;

ALTER TABLE public.programs
  DROP CONSTRAINT IF EXISTS programs_registration_mode_check;
ALTER TABLE public.programs
  ADD CONSTRAINT programs_registration_mode_check
  CHECK (registration_mode = ANY (ARRAY['enrops'::text, 'partner'::text]));

COMMENT ON COLUMN public.programs.registration_mode IS
  'Who handles registration: enrops (we run checkout; shows in public catalog) or partner (partner/venue runs their own registration; program is live + scheduled + on rosters but never shown in the public catalog with a checkout).';
COMMENT ON COLUMN public.programs.external_registration_url IS
  'Optional link to the partner''s own registration page, for marketing emails. Only meaningful when registration_mode = partner.';
