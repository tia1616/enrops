-- 20260601_derive_dates_drop_charter_check.sql
--
-- Drops the dead-code `v_district <> 'Charter/Private'` branch from
-- derive_program_session_dates(). The Charter/Private rows in
-- program_locations.district were renamed to their actual school names
-- (Catlin Gabel, OES, etc.) earlier today, so the literal 'Charter/Private'
-- value no longer exists in any row and the check is misleading.
--
-- Convention going forward: every calendar source is its own district
-- value. No special-case strings.

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
  v_location_closures DATE[];
  v_district      TEXT;
  v_org_id        UUID;
  v_term          TEXT;
  v_school_year   TEXT;
  v_district_closures DATE[];
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

  SELECT
    COALESCE(pl.closure_dates, '{}'),
    pl.district
  INTO v_location_closures, v_district
  FROM program_locations pl
  WHERE pl.id = v_location_id;

  v_school_year := term_to_school_year(v_term);
  IF v_district IS NOT NULL AND v_school_year IS NOT NULL THEN
    SELECT COALESCE(
      ARRAY(
        SELECT (elem->>'date')::date
        FROM jsonb_array_elements(dc.no_school_dates) AS elem
        WHERE elem->>'date' IS NOT NULL
      ),
      '{}'::date[]
    )
    INTO v_district_closures
    FROM district_calendars dc
    WHERE dc.organization_id = v_org_id
      AND dc.district = v_district
      AND dc.school_year = v_school_year;
  END IF;

  v_district_closures := COALESCE(v_district_closures, '{}'::date[]);
  v_all_closures := v_location_closures || v_district_closures;

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
