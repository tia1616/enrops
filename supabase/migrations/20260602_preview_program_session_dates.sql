-- Preview variant of derive_program_session_dates.
-- The saved-row version reads a programs.id; this one takes raw inputs so the
-- create-program wizard can preview the holiday-aware session dates before
-- the row exists.
--
-- Logic mirrors derive_program_session_dates EXACTLY -- same closure sources
-- (location closure_dates + district_calendars.no_school_dates), same
-- weekly stride, same lookup cap. If derive_program_session_dates changes,
-- update both together.
--
-- Security: INVOKER. The function reads RLS-gated tables
-- (program_locations + district_calendars), so org scoping is enforced by
-- RLS on the underlying tables.

CREATE OR REPLACE FUNCTION public.preview_program_session_dates(
  p_organization_id uuid,
  p_location_id    uuid,
  p_term           text,
  p_first_date     date,
  p_count          integer
)
RETURNS date[]
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_location_closures DATE[] := '{}';
  v_district          TEXT;
  v_school_year       TEXT;
  v_district_closures DATE[] := '{}';
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
    SELECT
      COALESCE(pl.closure_dates, '{}'),
      pl.district
    INTO v_location_closures, v_district
    FROM program_locations pl
    WHERE pl.id = p_location_id;
  END IF;

  v_school_year := term_to_school_year(p_term);
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
    WHERE dc.organization_id = p_organization_id
      AND dc.district = v_district
      AND dc.school_year = v_school_year;
  END IF;

  v_district_closures := COALESCE(v_district_closures, '{}'::date[]);
  v_all_closures := v_location_closures || v_district_closures;

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
$function$;

GRANT EXECUTE ON FUNCTION public.preview_program_session_dates(uuid, uuid, text, date, integer) TO authenticated;
