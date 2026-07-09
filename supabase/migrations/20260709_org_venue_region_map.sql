-- De-hardcode the camp VENUE_REGION_MAP (was a J2S-specific constant in
-- match-instructors/lib.ts). Per-org config; the camp matcher AND the camp survey
-- form both read this single source, so location prefs finally match what the
-- matcher looks up (they were dead: form stored venue names, matcher read regions).
--
-- Additive + backfilled-empty. The matcher falls back to its built-in constant when
-- this is empty, so behavior is unchanged until seeded. Seed each org's map from the
-- venue->region data (program_locations.area, filling any camp-only venues) as a
-- separate verified step per environment. Apply to prod BEFORE the frontend/matcher
-- that read it deploy.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS venue_region_map jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.organizations.venue_region_map IS
  'Maps each camp venue (camp_sessions.location_name) to its region/area. Camp survey shows distinct regions; the camp matcher scores location prefs by region.';
