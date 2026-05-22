-- Chunk 3 scope additions (decided 2026-05-22): minor-instructor detection
-- and admin-uploaded background-check fields.
--
-- NOT YET APPLIED. Awaiting Jessica's explicit go-ahead before running this
-- against the live project (`iuasfpztkmrtagivlhtj`).
--
-- Apply via:
--   mcp__833d47bc-073c-4a98-8287-6eeedcf5a6c7__apply_migration
-- or the Supabase Dashboard SQL editor.

-- ---------------------------------------------------------------------------
-- Feature A: admin-uploaded background checks
--
-- Admins can mark an instructor as background-check-cleared without going
-- through Checkr (most current J2S instructors already have valid checks on
-- file from prior years — re-running them costs $ per report).
--
-- Schema choice: new columns on contractor_onboarding_status. Keeping it on
-- the same row avoids a second JOIN every time the gate check reads BG state,
-- and the "one row per instructor onboarding journey" mental model stays
-- intact. A separate instructor_background_checks table makes sense only if
-- we ever need a history of multiple checks per instructor, which v1 doesn't.
-- ---------------------------------------------------------------------------

ALTER TABLE public.contractor_onboarding_status
  ADD COLUMN background_check_source TEXT NOT NULL DEFAULT 'checkr'
    CHECK (background_check_source IN ('checkr', 'admin_uploaded')),
  ADD COLUMN background_check_file_url TEXT,
  ADD COLUMN background_check_uploaded_by UUID REFERENCES auth.users(id),
  ADD COLUMN background_check_completed_on DATE;

COMMENT ON COLUMN public.contractor_onboarding_status.background_check_source IS
  'How the background check was recorded: ''checkr'' = ran through Checkr API, ''admin_uploaded'' = admin uploaded a prior-year report PDF.';
COMMENT ON COLUMN public.contractor_onboarding_status.background_check_file_url IS
  'Storage path inside contractor-documents bucket. Set when source = admin_uploaded.';
COMMENT ON COLUMN public.contractor_onboarding_status.background_check_uploaded_by IS
  'auth.users.id of the admin who uploaded the prior report. Null when source = checkr.';
COMMENT ON COLUMN public.contractor_onboarding_status.background_check_completed_on IS
  'Date of the original background check (per the uploaded record). Null when source = checkr (timestamp is in checkr_completed_at instead).';

-- ---------------------------------------------------------------------------
-- Feature B: minor-instructor detection
--
-- Schema choice: date_of_birth DATE (Option A from the handoff). More
-- accurate than a boolean (auto-ages-up on 18th birthday), future-proof
-- (we'll likely want DOB anyway for tax forms / age-restricted offerings),
-- and is what Checkr collects for adults so the data shape is consistent.
-- Backfill by admin UI for Finn + August in summer 2026.
--
-- Nullable: existing adult instructors will have a NULL DOB until admin
-- enters it. Code that branches on "is minor" treats NULL as "adult by
-- default" — the routing logic explicitly only treats a populated DOB-under-
-- 18 as a minor.
-- ---------------------------------------------------------------------------

ALTER TABLE public.instructors
  ADD COLUMN date_of_birth DATE;

COMMENT ON COLUMN public.instructors.date_of_birth IS
  'Optional. Used by the contractor onboarding wizard to detect minor instructors and route them to the schedule view instead of the onboarding flow. NULL = treated as adult (default).';
