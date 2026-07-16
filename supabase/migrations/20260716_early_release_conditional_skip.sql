-- 20260716_early_release_conditional_skip.sql
--
-- Early-release dates were captured (district_calendars.early_release_dates)
-- but never subtracted from a program's session dates - the prior comment on
-- derive_program_session_dates said so explicitly: "Early-release dates are
-- NOT subtracted - programs still meet on those days."
--
-- Found via a real scheduling miss at Alameda Elementary (Portland district):
-- 2 of 8 Wednesday sessions landed on early-release days, where kids leave
-- before the afterschool program would start.
--
-- BUSINESS RULE (confirmed with Jessica 2026-07-16):
--   - If a location's class weekday is occasionally early release (some
--     weeks normal, some early) -> the class can't meet at its normal time
--     that day. Skip it, same as a holiday (push the session later).
--   - If a location's class weekday is EVERY WEEK early release for the
--     whole school year (e.g. Lake Oswego SD releases every Thursday for
--     staff PLCs) -> that's just how the day runs there. Don't skip - the
--     class keeps meeting every week, just needs its time set for right
--     after the (consistently) early dismissal. That's a one-time time
--     correction on the program (already handled for Hallinan), not a
--     per-date skip.
--
-- So early-release dates are conditionally subtracted: only the dates that
-- are EXCEPTIONS to the location's normal weekly pattern for that weekday,
-- never a weekday where 100% of the school year's occurrences are early
-- release (that's the location's normal schedule, not a closure).
--
-- Updated after code review (2026-07-16):
--   - The "is this weekday 100% early-release" check now compares two counts
--     built with the SAME filters (bounded to the calendar's school year,
--     deduped, excluding dates that are also holidays) - the first draft
--     compared a bounded/deduped total against an unbounded/undeduped
--     early-release count, which could misfire on stray or duplicate calendar
--     data and wrongly skip a location's genuinely-consistent early-release
--     weekday (the mirror image of the bug this migration fixes).
--   - derive_program_session_schedule() (the admin ProgramsCalendar.jsx
--     "full schedule with closures shown" view, added in
--     20260709_program_session_schedule_with_closures.sql) is rewired here
--     too - it was not touched by the first draft, which would have left the
--     admin calendar showing different dates than derive_program_session_dates.
--     Early-release exceptions render there with kind='no_school' (reusing
--     the existing frontend branch - no frontend change needed) and their own
--     reason label, alongside the existing holiday reasons.

-- ──────────────────────────────────────────────────────────────────────
-- Early-release EXCEPTION dates for a location+weekday+term: only the
-- early-release dates on that weekday, and only if that weekday ISN'T
-- consistently early-release all year for the applicable district calendar(s).
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION resolve_district_early_release_exceptions(
  p_org_id UUID,
  p_location_id UUID,
  p_term TEXT,
  p_weekday INTEGER
)
RETURNS DATE[]
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_result DATE[] := '{}';
  dc RECORD;
  v_holiday_dates DATE[];
  v_total_weekday INTEGER;
  v_early_weekday DATE[];
BEGIN
  IF p_weekday IS NULL THEN
    RETURN '{}';
  END IF;

  FOR dc IN SELECT * FROM matching_district_calendars(p_org_id, p_location_id, p_term) LOOP
    IF dc.first_day_of_school IS NULL OR dc.last_day_of_school IS NULL THEN
      CONTINUE;
    END IF;

    v_holiday_dates := ARRAY(
      SELECT (elem->>'date')::date
      FROM jsonb_array_elements(dc.no_school_dates) AS elem
      WHERE elem->>'date' IS NOT NULL
    );

    -- how many school days fall on this weekday across the whole school year
    -- for this calendar (excluding actual no-school/holiday days)
    SELECT count(*)
    INTO v_total_weekday
    FROM generate_series(dc.first_day_of_school, dc.last_day_of_school, interval '1 day') AS gs(d)
    WHERE EXTRACT(DOW FROM gs.d) = p_weekday
      AND NOT (gs.d::date = ANY(v_holiday_dates));

    -- the early-release dates on this weekday for this calendar - bounded to
    -- the same school-year range, deduped, and excluding any date that is
    -- ALSO a holiday - same filters as v_total_weekday above, so the two
    -- counts are comparable apples-to-apples.
    v_early_weekday := ARRAY(
      SELECT DISTINCT (elem->>'date')::date
      FROM jsonb_array_elements(dc.early_release_dates) AS elem
      WHERE elem->>'date' IS NOT NULL
        AND (elem->>'date')::date BETWEEN dc.first_day_of_school AND dc.last_day_of_school
        AND EXTRACT(DOW FROM (elem->>'date')::date) = p_weekday
        AND NOT ((elem->>'date')::date = ANY(v_holiday_dates))
    );

    -- only treat these as skip-worthy EXCEPTIONS if the weekday is NOT
    -- consistently early-release for the whole year at this calendar
    IF v_total_weekday > 0 AND v_total_weekday = COALESCE(array_length(v_early_weekday, 1), 0) THEN
      CONTINUE; -- every occurrence is early release -> that's the normal schedule, not an exception
    END IF;

    v_result := v_result || v_early_weekday;
  END LOOP;

  RETURN COALESCE(v_result, '{}'::date[]);
END;
$func$;

COMMENT ON FUNCTION resolve_district_early_release_exceptions(UUID, UUID, TEXT, INTEGER) IS
  'Early-release dates that fall on a program''s weekday and are EXCEPTIONS to that location''s normal pattern (some weeks early, some not) - these get skipped like a holiday. If a weekday is early-release 100% of the school year for a calendar (e.g. every Thursday), those dates are excluded here - that is the location''s normal schedule, not something to skip, and needs a program time correction instead. Both counts in the 100%-check use the same bounded/deduped/holiday-excluded filter so stray or duplicate calendar data cannot flip the classification.';

GRANT EXECUTE ON FUNCTION resolve_district_early_release_exceptions(UUID, UUID, TEXT, INTEGER) TO authenticated;

-- ──────────────────────────────────────────────────────────────────────
-- Rewire derive_program_session_dates to also subtract early-release
-- EXCEPTIONS (not the consistently-early-release weekdays)
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
    p.term
  INTO v_first_date, v_count, v_location_id, v_org_id, v_term
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
  v_early_release_exceptions := resolve_district_early_release_exceptions(v_org_id, v_location_id, v_term, v_weekday);

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
  'Returns the chronological list of dates a program meets, skipping location closure_dates, district_calendars.no_school_dates, and early-release EXCEPTION dates (occasional early release on this weekday). A weekday that is early-release every week all year (e.g. every Thursday) is NOT skipped - that is the location''s normal schedule; its program time should be set for right after that consistent early dismissal.';

GRANT EXECUTE ON FUNCTION derive_program_session_dates(UUID) TO authenticated;

-- ──────────────────────────────────────────────────────────────────────
-- Rewire preview_program_session_dates (wizard live preview) to match derive
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION preview_program_session_dates(
  p_organization_id UUID,
  p_location_id UUID,
  p_term TEXT,
  p_first_date DATE,
  p_count INTEGER
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
  v_early_release_exceptions := resolve_district_early_release_exceptions(p_organization_id, p_location_id, p_term, v_weekday);

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

COMMENT ON FUNCTION preview_program_session_dates(UUID, UUID, TEXT, DATE, INTEGER) IS
  'Live wizard preview of session dates for an UNSAVED program. Shares resolve_district_closures() and resolve_district_early_release_exceptions() with derive_program_session_dates() so the preview always matches the dates the saved program will get.';

GRANT EXECUTE ON FUNCTION preview_program_session_dates(UUID, UUID, TEXT, DATE, INTEGER) TO authenticated;

-- ──────────────────────────────────────────────────────────────────────
-- Rewire derive_program_session_schedule (admin ProgramsCalendar.jsx "full
-- schedule with closures shown" view) so it stops disagreeing with
-- derive_program_session_dates now that early-release exceptions are a
-- skip source. Early-release rows reuse kind='no_school' (the frontend
-- already renders that kind as a struck-through date + reason - no
-- frontend change needed) with their own reason label.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.derive_program_session_schedule(p_program_id uuid)
RETURNS TABLE(entry_date date, kind text, reason text)
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
  v_location_closures DATE[];
  v_district_closures DATE[];
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
         p.organization_id, p.term
  INTO v_first_date, v_count, v_location_id, v_org_id, v_term
  FROM programs p
  WHERE p.id = p_program_id;

  IF v_first_date IS NULL OR v_count IS NULL OR v_count <= 0 THEN
    RETURN;
  END IF;

  SELECT COALESCE(pl.closure_dates, '{}')
  INTO v_location_closures
  FROM program_locations pl
  WHERE pl.id = v_location_id;

  v_weekday := EXTRACT(DOW FROM v_first_date);
  v_district_closures := resolve_district_closures(v_org_id, v_location_id, v_term);
  v_early_release_exceptions := resolve_district_early_release_exceptions(v_org_id, v_location_id, v_term, v_weekday);
  v_all_closures := v_location_closures || v_district_closures || v_early_release_exceptions;

  -- Map each district no-school DATE -> a human reason ("Labor Day"), blank
  -- reason falls back to "No school". DISTINCT ON dedupes dates that appear in
  -- more than one matched calendar, preferring a non-empty reason.
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

  -- Same reason lookup for early-release dates, so an early-release skip
  -- shows its real reason ("Early Release Days") instead of "No school".
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

  -- Walk the weekly cadence. Emit each skipped closure as a no_school row, and
  -- each meeting as a session row, stopping once session_count meetings emit.
  -- The session/skip decision mirrors derive_program_session_dates EXACTLY
  -- (same `NOT (candidate = ANY(closures))` test, including its NULL-array
  -- semantics for a location-less program) so the session rows are byte-
  -- identical; the no_school branch is purely additive.
  WHILE v_added < v_count AND i < v_max_lookups LOOP
    v_candidate := v_first_date + (i * 7);
    IF NOT (v_candidate = ANY(v_all_closures)) THEN
      entry_date := v_candidate;
      kind := 'session';
      reason := NULL;
      RETURN NEXT;
      v_added := v_added + 1;
    ELSIF v_candidate = ANY(v_all_closures) THEN
      entry_date := v_candidate;
      kind := 'no_school';
      -- district holiday -> its reason; early-release exception -> its
      -- reason; location-only closure -> generic label
      reason := COALESCE(
        v_district_reasons ->> to_char(v_candidate, 'YYYY-MM-DD'),
        v_early_release_reasons ->> to_char(v_candidate, 'YYYY-MM-DD'),
        'No class'
      );
      RETURN NEXT;
    END IF;
    -- NULL v_all_closures (no program_location_id) falls through both branches,
    -- emitting nothing — identical to derive_program_session_dates.
    i := i + 1;
  END LOOP;

  RETURN;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.derive_program_session_schedule(uuid) TO anon, authenticated, service_role;
