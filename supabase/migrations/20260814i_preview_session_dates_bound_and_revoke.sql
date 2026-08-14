-- 20260814i_preview_session_dates_bound_and_revoke.sql
--
-- Code-review finding, 14 Aug. PRE-EXISTING, not introduced by this feature --
-- but it is the one remaining instance of exactly the hazard 20260814h was
-- written to close, on the sibling function, and unlike the range one it IS live
-- on prod today (verified: 5-arg form, anon EXECUTE true, ACL carries the PUBLIC
-- `=X` entry).
--
-- preview_program_session_dates takes p_count from the caller and derives the
-- loop's own cap from it:
--     v_max_lookups := p_count * 2 + ...
-- The only guard is p_count <= 0. An unauthenticated POST with p_count of
-- 100000000 passes it and walks, appending to a plpgsql array each pass -- and
-- array append copies the whole array, so the work is quadratic. Same shape and
-- same reasoning 20260717_revoke_anon_range_fns.sql gave for the range pair:
-- "an unbounded date range is a cheap anon-callable server loop".
--
-- SECURITY INVOKER, so RLS still gates every read. Availability, not a leak.
--
-- BOTH fixes, because they cover different things:
--   1. The CLAMP bounds the loop for EVERY caller, including an authenticated
--      one that fat-fingers a session count. 500 is 30x the largest real value
--      on prod (max session_count = 15, nothing above 60), so no legitimate
--      preview is refused, and an absurd count returns '{}' exactly as a
--      non-positive one already does.
--   2. The REVOKE removes anon from a function no anonymous surface calls.
--      Checked before writing this, because revoking something a public page
--      quietly used is precisely how School calendar broke for a live tenant on
--      7 Aug: the ONLY caller in the repo is ProgramWizardNew.jsx:321, the admin
--      program wizard, which is authenticated. No edge function calls it, and no
--      view or other function references it.
--
-- CREATE OR REPLACE, not DROP -- the signature is unchanged, and replacing keeps
-- the ACL so the REVOKE below is the only thing that moves it. That is the rule
-- 20260814h had to be written to restore.
--
-- ORDERING: this targets the 6-arg form created by 20260814a, so it must run
-- after it. Alphabetical filename order already guarantees that (a < i), and on
-- prod the whole 20260814* set ships together.

CREATE OR REPLACE FUNCTION preview_program_session_dates(
  p_organization_id UUID,
  p_location_id UUID,
  p_term TEXT,
  p_first_date DATE,
  p_count INTEGER,
  p_early_release_start_time TEXT DEFAULT NULL
)
RETURNS DATE[]
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_location_closures DATE[] := '{}';
  v_district_closures DATE[] := '{}';
  v_early_release_exceptions DATE[] := '{}';
  v_weekday           INTEGER;
  v_all_closures      DATE[];
  v_result            DATE[] := '{}';
  v_candidate         DATE;
  v_max_lookups       INTEGER;
  v_added             INTEGER := 0;
  i                   INTEGER := 0;
BEGIN
  -- Upper bound added here. The loop's cap is derived FROM p_count, so without
  -- one the caller sets how long the server works.
  IF p_first_date IS NULL OR p_count IS NULL OR p_count <= 0 OR p_count > 500 THEN
    RETURN '{}';
  END IF;

  IF p_location_id IS NOT NULL THEN
    SELECT COALESCE(pl.closure_dates, '{}')
    INTO v_location_closures
    FROM program_locations pl WHERE pl.id = p_location_id;
  END IF;

  v_weekday := EXTRACT(DOW FROM p_first_date);
  v_district_closures := resolve_district_closures(p_organization_id, p_location_id, p_term);

  IF COALESCE(btrim(p_early_release_start_time), '') = '' THEN
    v_early_release_exceptions := resolve_district_early_release_exceptions(p_organization_id, p_location_id, p_term, v_weekday);
  ELSE
    v_early_release_exceptions := '{}';
  END IF;

  v_all_closures := v_location_closures || v_district_closures || v_early_release_exceptions;
  v_max_lookups := p_count * 2 + COALESCE(array_length(v_all_closures, 1), 0);

  WHILE v_added < p_count AND i < v_max_lookups LOOP
    v_candidate := p_first_date + (i * 7);
    IF NOT (v_candidate = ANY(v_all_closures)) THEN
      v_result := v_result || v_candidate;
      v_added := v_added + 1;
    END IF;
    i := i + 1;
  END LOOP;

  RETURN v_result;
END;
$func$;

COMMENT ON FUNCTION preview_program_session_dates(UUID, UUID, TEXT, DATE, INTEGER, TEXT) IS
  'Live wizard preview of session dates for an UNSAVED program. Shares resolve_district_closures() and resolve_district_early_release_exceptions() with derive_program_session_dates() so the preview always matches the dates the saved program will get. p_count is bounded at 500: the loop cap derives from it, so an unbounded value lets a caller choose how long the server works.';

REVOKE EXECUTE ON FUNCTION preview_program_session_dates(UUID, UUID, TEXT, DATE, INTEGER, TEXT) FROM public, anon;
GRANT  EXECUTE ON FUNCTION preview_program_session_dates(UUID, UUID, TEXT, DATE, INTEGER, TEXT) TO authenticated, service_role;
