-- Per-program registration ownership, mirroring camp_sessions.runs_own_registration.
--
-- A program is either run by the provider through Enrops (default — public
-- catalog + Stripe checkout) or run by the partner/venue themselves. Partner-run
-- programs are live, get matched/scheduled, and show on rosters + the calendar,
-- but are NEVER shown in the public catalog with a checkout.
--
-- Additive + default-preserving: every existing program is
-- runs_own_registration = false, so behavior is unchanged until a program is
-- explicitly marked partner-run. No RLS change — columns inherit the existing
-- programs row policies.

ALTER TABLE public.programs
  ADD COLUMN IF NOT EXISTS runs_own_registration boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS external_registration_url text;

COMMENT ON COLUMN public.programs.runs_own_registration IS
  'True = the partner/venue runs registration themselves; the program is live + scheduled + on rosters but never shown in the public catalog with a checkout. False (default) = we run registration via the public catalog + checkout. Mirrors camp_sessions.runs_own_registration.';
COMMENT ON COLUMN public.programs.external_registration_url IS
  'Optional link to the partner''s own registration page, for marketing emails. Only meaningful when runs_own_registration = true.';
