-- 20260814a_early_release_still_meet.sql
--
-- Jessica, 14 Aug 2026: on an OCCASIONAL early-release day the class is not
-- cancelled -- the school lets out earlier and the class starts earlier. Today
-- those dates are always skipped and there is no override anywhere in the
-- schema. On Jeff's real 2026-2027 data that is 20 of his 21 programs: PPS
-- (13 programs, 8 occasional ER dates) and Cascadia (2, 8) skip every one, and
-- LOSD (5) keeps its consistent Thursday but skips his Mon/Tue/Wed classes on
-- LOSD's other ER dates.
--
-- THIS DOES NOT TOUCH district_calendars. Not one row is written, re-derived,
-- re-parsed or re-extracted. The four calendars Jeff uploaded on 5-6 Aug are
-- the only copy that exists -- extract-district-calendar is an AI extraction of
-- a PDF the product does not keep, so it is not a recovery path. This migration
-- reads early_release_dates exactly as 20260716 already did, and adds the
-- override on the PROGRAM instead. consistent_early_release_weekdays is not
-- read, not written and not recomputed here.
--
-- THE EXISTING RULE IS UNCHANGED (20260716_early_release_conditional_skip.sql,
-- confirmed with Jessica 16 Jul): a weekday that is early-release EVERY week
-- all year is not an exception at all, it is the location's normal schedule,
-- and resolve_district_early_release_exceptions already excludes it. That
-- function is not modified. This only decides what to do with the dates it
-- does return.
--
-- SHAPE: two nullable TEXT columns on programs, matching start_time/end_time
-- which are also TEXT (not TIME) on this table.
--     early_release_start_time IS NULL  -> skip the date. Exactly today's
--                                          behaviour, so every existing
--                                          program is unchanged and there is
--                                          no backfill.
--     early_release_start_time IS SET   -> the class still meets, at that time.
-- An empty string counts as unset: these are free-text inputs and a cleared
-- field can save '' rather than NULL, which must not read as "meets at no time".

ALTER TABLE public.programs
  ADD COLUMN IF NOT EXISTS early_release_start_time TEXT,
  ADD COLUMN IF NOT EXISTS early_release_end_time   TEXT;

COMMENT ON COLUMN public.programs.early_release_start_time IS
  'When set, this program STILL MEETS on occasional early-release days, starting at this time instead of start_time. NULL or empty = skip those dates (the behaviour before 20260814a). Never applies to a weekday that is early-release all year -- that is the location''s normal schedule and was never skipped.';
COMMENT ON COLUMN public.programs.early_release_end_time IS
  'Optional end time on occasional early-release days. NULL = only the start time is known; surfaces show the start alone rather than inventing an end.';

-- programs has TABLE-level SELECT for anon and authenticated (verified, not
-- assumed: has_table_privilege true for both), so new columns are readable
-- without an explicit grant and the public catalog's select=* keeps working.
-- This is deliberately checked here because districts and program_locations
-- are the opposite -- column allowlists -- and a new column on either of those
-- WOULD need granting. That distinction caused a live outage on 7 Aug.

-- ──────────────────────────────────────────────────────────────────────
-- derive_program_session_dates: stop subtracting early-release exceptions
-- for a program that has opted to keep meeting.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION derive_program_session_dates(p_program_id UUID)
RETURNS DATE[]
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_first_date    DATE;
  v_count         INTEGER;
  v_location_id   UUID;
  v_org_id        UUID;
  v_term          TEXT;
  v_weekday       INTEGER;
  v_er_start      TEXT;
  v_location_closures DATE[];
  v_district_closures DATE[];
  v_early_release_exceptions DATE[];
  v_all_closures  DATE[];
  v_result        DATE[] := '{}';
  v_candidate     DATE;
  v_max_lookups   INTEGER;
  v_added         INTEGER := 0;
  i               INTEGER := 0;
BEGIN
  SELECT
    p.first_session_date,
    p.session_count,
    p.program_location_id,
    p.organization_id,
    p.term,
    p.early_release_start_time
  INTO v_first_date, v_count, v_location_id, v_org_id, v_term, v_er_start
  FROM programs p
  WHERE p.id = p_program_id;

  IF v_first_date IS NULL OR v_count IS NULL OR v_count <= 0 THEN
    RETURN '{}';
  END IF;

  SELECT COALESCE(pl.closure_dates, '{}')
  INTO v_location_closures
  FROM program_locations pl
  WHERE pl.id = v_location_id;

  v_weekday := EXTRACT(DOW FROM v_first_date);
  v_district_closures := resolve_district_closures(v_org_id, v_location_id, v_term);

  -- THE ONLY BEHAVIOUR CHANGE. Opted in -> these dates are not closures.
  IF COALESCE(btrim(v_er_start), '') = '' THEN
    v_early_release_exceptions := resolve_district_early_release_exceptions(v_org_id, v_location_id, v_term, v_weekday);
  ELSE
    v_early_release_exceptions := '{}';
  END IF;

  v_all_closures := v_location_closures || v_district_closures || v_early_release_exceptions;
  v_max_lookups := v_count * 2 + COALESCE(array_length(v_all_closures, 1), 0);

  WHILE v_added < v_count AND i < v_max_lookups LOOP
    v_candidate := v_first_date + (i * 7);
    IF NOT (v_candidate = ANY(v_all_closures)) THEN
      v_result := v_result || v_candidate;
      v_added := v_added + 1;
    END IF;
    i := i + 1;
  END LOOP;

  RETURN v_result;
END;
$func$;

COMMENT ON FUNCTION derive_program_session_dates(UUID) IS
  'Returns the chronological list of dates a program meets, skipping location closure_dates, district_calendars.no_school_dates, and early-release EXCEPTION dates. A program with early_release_start_time set keeps those early-release dates and meets at that earlier time instead. A weekday that is early-release every week all year is never skipped either way -- that is the location''s normal schedule.';

GRANT EXECUTE ON FUNCTION derive_program_session_dates(UUID) TO authenticated;

-- ──────────────────────────────────────────────────────────────────────
-- preview_program_session_dates: the wizard preview must agree with the
-- saved program, so it needs the same override for an UNSAVED one.
-- The 5-arg version is dropped rather than left beside a 6-arg overload:
-- a 5-argument call would match both and Postgres would refuse it as
-- ambiguous. The new last argument defaults to NULL, so existing 5-arg
-- callers keep working unchanged.
-- ──────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS preview_program_session_dates(UUID, UUID, TEXT, DATE, INTEGER);

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
  IF p_first_date IS NULL OR p_count IS NULL OR p_count <= 0 THEN
    RETURN '{}';
  END IF;

  IF p_location_id IS NOT NULL THEN
    SELECT COALESCE(pl.closure_dates, '{}')
    INTO v_location_closures
    FROM program_locations pl
    WHERE pl.id = p_location_id;
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
  'Live wizard preview of session dates for an UNSAVED program. Shares resolve_district_closures() and resolve_district_early_release_exceptions() with derive_program_session_dates() so the preview always matches the dates the saved program will get -- including the early-release override, passed here because there is no program row to read it from yet.';

GRANT EXECUTE ON FUNCTION preview_program_session_dates(UUID, UUID, TEXT, DATE, INTEGER, TEXT) TO authenticated;

-- ──────────────────────────────────────────────────────────────────────
-- derive_program_session_schedule: same decision, plus it now returns the
-- TIME each session meets at, so a kept early-release date can show its
-- earlier time instead of silently looking like a normal one.
--
-- The return type gains a column, which CREATE OR REPLACE cannot do, so the
-- function is dropped and recreated. The three readers (ProgramsCalendar,
-- the parent Dashboard, InstructorPortal) all pick fields by name and ignore
-- extras, so an added column does not break them.
-- ──────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.derive_program_session_schedule(uuid);

CREATE OR REPLACE FUNCTION public.derive_program_session_schedule(p_program_id uuid)
RETURNS TABLE(entry_date date, kind text, reason text, session_time text)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_first_date        DATE;
  v_count             INTEGER;
  v_location_id       UUID;
  v_org_id            UUID;
  v_term              TEXT;
  v_weekday           INTEGER;
  v_start_time        TEXT;
  v_er_start          TEXT;
  v_opted_in          BOOLEAN;
  v_location_closures DATE[];
  v_district_closures DATE[];
  v_er_exceptions_all DATE[];
  v_early_release_exceptions DATE[];
  v_all_closures      DATE[];
  v_district_reasons  JSONB := '{}'::jsonb;
  v_early_release_reasons JSONB := '{}'::jsonb;
  v_candidate         DATE;
  v_max_lookups       INTEGER;
  v_added             INTEGER := 0;
  i                   INTEGER := 0;
BEGIN
  SELECT p.first_session_date, p.session_count, p.program_location_id,
         p.organization_id, p.term, p.start_time, p.early_release_start_time
  INTO v_first_date, v_count, v_location_id, v_org_id, v_term, v_start_time, v_er_start
  FROM programs p
  WHERE p.id = p_program_id;

  IF v_first_date IS NULL OR v_count IS NULL OR v_count <= 0 THEN
    RETURN;
  END IF;

  v_opted_in := COALESCE(btrim(v_er_start), '') <> '';

  SELECT COALESCE(pl.closure_dates, '{}')
  INTO v_location_closures
  FROM program_locations pl
  WHERE pl.id = v_location_id;

  v_weekday := EXTRACT(DOW FROM v_first_date);
  v_district_closures := resolve_district_closures(v_org_id, v_location_id, v_term);

  -- Always resolved, even when opted in: opting in changes whether these dates
  -- are SKIPPED, not whether we know which ones they are. The kept ones still
  -- need to be recognised so they can carry the earlier time.
  v_er_exceptions_all := resolve_district_early_release_exceptions(v_org_id, v_location_id, v_term, v_weekday);
  v_early_release_exceptions := CASE WHEN v_opted_in THEN '{}'::date[] ELSE v_er_exceptions_all END;

  v_all_closures := v_location_closures || v_district_closures || v_early_release_exceptions;

  SELECT COALESCE(jsonb_object_agg(d, r), '{}'::jsonb)
  INTO v_district_reasons
  FROM (
    SELECT DISTINCT ON (elem->>'date')
      elem->>'date' AS d,
      COALESCE(NULLIF(TRIM(elem->>'reason'), ''), 'No school') AS r
    FROM matching_district_calendars(v_org_id, v_location_id, v_term) dc
    CROSS JOIN LATERAL jsonb_array_elements(dc.no_school_dates) AS elem
    WHERE elem->>'date' IS NOT NULL
    ORDER BY elem->>'date', (NULLIF(TRIM(elem->>'reason'), '')) NULLS LAST
  ) x;

  SELECT COALESCE(jsonb_object_agg(d, r), '{}'::jsonb)
  INTO v_early_release_reasons
  FROM (
    SELECT DISTINCT ON (elem->>'date')
      elem->>'date' AS d,
      COALESCE(NULLIF(TRIM(elem->>'reason'), ''), 'Early release') AS r
    FROM matching_district_calendars(v_org_id, v_location_id, v_term) dc
    CROSS JOIN LATERAL jsonb_array_elements(dc.early_release_dates) AS elem
    WHERE elem->>'date' IS NOT NULL
    ORDER BY elem->>'date', (NULLIF(TRIM(elem->>'reason'), '')) NULLS LAST
  ) x;

  v_max_lookups := v_count * 2 + COALESCE(array_length(v_all_closures, 1), 0);

  WHILE v_added < v_count AND i < v_max_lookups LOOP
    v_candidate := v_first_date + (i * 7);
    IF NOT (v_candidate = ANY(v_all_closures)) THEN
      entry_date := v_candidate;
      kind := 'session';
      -- A kept early-release date meets EARLIER. Every other session keeps the
      -- program's normal time, so callers always get a usable value and never
      -- have to guess which rule applied.
      IF v_opted_in AND v_candidate = ANY(v_er_exceptions_all) THEN
        reason := 'Early release';
        session_time := v_er_start;
      ELSE
        reason := NULL;
        session_time := v_start_time;
      END IF;
      RETURN NEXT;
      v_added := v_added + 1;
    ELSIF v_candidate = ANY(v_all_closures) THEN
      entry_date := v_candidate;
      kind := 'no_school';
      reason := COALESCE(
        v_district_reasons ->> to_char(v_candidate, 'YYYY-MM-DD'),
        v_early_release_reasons ->> to_char(v_candidate, 'YYYY-MM-DD'),
        'No class'
      );
      session_time := NULL;
      RETURN NEXT;
    END IF;
    i := i + 1;
  END LOOP;

  RETURN;
END;
$function$;

COMMENT ON FUNCTION public.derive_program_session_schedule(uuid) IS
  'Full schedule for a program: every meeting date plus every skipped closure with its reason. session_time is the time that meeting starts -- the program''s start_time normally, and early_release_start_time on a kept early-release date. A kept early-release session carries kind=session with reason=Early release, so a surface can label it without re-deriving which dates those are.';

GRANT EXECUTE ON FUNCTION public.derive_program_session_schedule(uuid) TO anon, authenticated, service_role;
