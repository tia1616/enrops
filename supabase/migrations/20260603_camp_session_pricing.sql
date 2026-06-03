-- Camp pricing on camp_sessions.
-- Mirrors after-school pricing on programs (price_cents + EB price + EB
-- deadline) so marketing tokens {{regular_price}} / {{early_bird_price}} /
-- {{savings}} / {{early_bird_deadline}} can be resolved for camp campaigns.
-- All three columns nullable — a tenant whose camps have no EB pricing
-- leaves the EB columns null and the marketing renderer suppresses EB
-- language. Partner-run camps (runs_own_registration=false where the
-- partner sets price) keep price_cents null too — we don't quote prices
-- we don't set.
--
-- Applied to prod via Supabase MCP on 2026-06-03. This file mirrors that
-- write for source control.
ALTER TABLE public.camp_sessions
  ADD COLUMN IF NOT EXISTS price_cents integer,
  ADD COLUMN IF NOT EXISTS early_bird_price_cents integer,
  ADD COLUMN IF NOT EXISTS early_bird_deadline date;

ALTER TABLE public.camp_sessions
  DROP CONSTRAINT IF EXISTS camp_sessions_eb_lower_than_regular;
ALTER TABLE public.camp_sessions
  ADD CONSTRAINT camp_sessions_eb_lower_than_regular
  CHECK (
    early_bird_price_cents IS NULL
    OR price_cents IS NULL
    OR early_bird_price_cents < price_cents
  );

ALTER TABLE public.camp_sessions
  DROP CONSTRAINT IF EXISTS camp_sessions_eb_deadline_requires_eb_price;
ALTER TABLE public.camp_sessions
  ADD CONSTRAINT camp_sessions_eb_deadline_requires_eb_price
  CHECK (
    early_bird_deadline IS NULL
    OR early_bird_price_cents IS NOT NULL
  );
