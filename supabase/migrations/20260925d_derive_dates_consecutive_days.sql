-- Teach the two date-deriving functions that a program can run on consecutive
-- days. See 20260925c for why: a camp is a program, not a second kind of thing.
--
-- The change in each is the stepping rule and a weekday test, nothing else:
--     weekly (class_days IS NULL):  candidate := first_date + (i * 7)   -- as before
--     camp   (class_days set):      candidate := first_date + i, and a candidate
--                                   whose weekday is not in class_days is skipped
--                                   WITHOUT consuming a session
--
-- Closures, early-release handling, reasons and the session/no_school split are
-- untouched and still apply to a camp - a camp that runs through a district
-- closure day should skip it exactly like a class does.
--
-- v_max_lookups widens for the camp case only. The weekly bound (count * 2) is
-- generous when one step is a whole week; stepping a day at a time needs room
-- for the gaps, so a camp gets count * 7. Same runaway guard, correct scale.
--
-- NULL takes the original path in both functions, so all 102 live programs
-- derive byte-identical dates.

CREATE OR REPLACE FUNCTION public.derive_program_session_dates(p_program_id uuid)
 RETURNS date[]
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_first_date    DATE;
  v_count         INTEGER;
  v_location_id   UUID;
  v_org_id        UUID;
  v_term          TEXT;
  v_weekday       INTEGER;
  v_er_start      TEXT;
  v_class_days    TEXT[];
  v_consecutive   BOOLEAN;
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
  SELECT p.first_session_date, p.session_count, p.program_location_id,
         p.organization_id, p.term, p.early_release_start_time, p.class_days
  INTO v_first_date, v_count, v_location_id, v_org_id, v_term, v_er_start, v_class_days
  FROM programs p WHERE p.id = p_program_id;

  IF v_first_date IS NULL OR v_count IS NULL OR v_count <= 0 THEN
    RETURN '{}';
  END IF;

  v_consecutive := v_class_days IS NOT NULL AND array_length(v_class_days, 1) > 0;

  SELECT COALESCE(pl.closure_dates, '{}')
  INTO v_location_closures
  FROM program_locations pl WHERE pl.id = v_location_id;

  v_weekday := EXTRACT(DOW FROM v_first_date);
  v_district_closures := resolve_district_closures(v_org_id, v_location_id, v_term);

  IF COALESCE(btrim(v_er_start), '') = '' THEN
    v_early_release_exceptions := resolve_district_early_release_exceptions(v_org_id, v_location_id, v_term, v_weekday);
  ELSE
    v_early_release_exceptions := '{}';
  END IF;

  v_all_closures := v_location_closures || v_district_closures || v_early_release_exceptions;
  v_max_lookups := CASE WHEN v_consecutive THEN v_count * 7 ELSE v_count * 2 END
                   + COALESCE(array_length(v_all_closures, 1), 0);

  WHILE v_added < v_count AND i < v_max_lookups LOOP
    v_candidate := CASE WHEN v_consecutive THEN v_first_date + i ELSE v_first_date + (i * 7) END;
    -- A day the camp does not meet is not a session and not a closure: it is
    -- simply not a day of this camp, so it consumes nothing.
    IF v_consecutive AND NOT ((ARRAY['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])[EXTRACT(DOW FROM v_candidate)::int + 1] = ANY(v_class_days)) THEN
      i := i + 1;
      CONTINUE;
    END IF;
    IF NOT (v_candidate = ANY(v_all_closures)) THEN
      v_result := v_result || v_candidate;
      v_added := v_added + 1;
    END IF;
    i := i + 1;
  END LOOP;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.derive_program_session_schedule(p_program_id uuid)
 RETURNS TABLE(entry_date date, kind text, reason text, session_time text, session_end_time text)
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
  v_end_time          TEXT;
  v_er_start          TEXT;
  v_er_end            TEXT;
  v_opted_in          BOOLEAN;
  v_class_days        TEXT[];
  v_consecutive       BOOLEAN;
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
         p.organization_id, p.term, p.start_time, p.end_time,
         p.early_release_start_time, p.early_release_end_time, p.class_days
  INTO v_first_date, v_count, v_location_id, v_org_id, v_term, v_start_time, v_end_time,
       v_er_start, v_er_end, v_class_days
  FROM programs p WHERE p.id = p_program_id;

  IF v_first_date IS NULL OR v_count IS NULL OR v_count <= 0 THEN
    RETURN;
  END IF;

  v_consecutive := v_class_days IS NOT NULL AND array_length(v_class_days, 1) > 0;
  v_opted_in := COALESCE(btrim(v_er_start), '') <> '';

  SELECT COALESCE(pl.closure_dates, '{}')
  INTO v_location_closures
  FROM program_locations pl WHERE pl.id = v_location_id;

  v_weekday := EXTRACT(DOW FROM v_first_date);
  v_district_closures := resolve_district_closures(v_org_id, v_location_id, v_term);

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

  v_max_lookups := CASE WHEN v_consecutive THEN v_count * 7 ELSE v_count * 2 END
                   + COALESCE(array_length(v_all_closures, 1), 0);

  WHILE v_added < v_count AND i < v_max_lookups LOOP
    v_candidate := CASE WHEN v_consecutive THEN v_first_date + i ELSE v_first_date + (i * 7) END;
    IF v_consecutive AND NOT ((ARRAY['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])[EXTRACT(DOW FROM v_candidate)::int + 1] = ANY(v_class_days)) THEN
      i := i + 1;
      CONTINUE;
    END IF;
    IF NOT (v_candidate = ANY(v_all_closures)) THEN
      entry_date := v_candidate;
      kind := 'session';
      IF v_opted_in AND v_candidate = ANY(v_er_exceptions_all) THEN
        reason := 'Early release';
        session_time := v_er_start;
        session_end_time := NULLIF(btrim(COALESCE(v_er_end, '')), '');
      ELSE
        reason := NULL;
        session_time := v_start_time;
        session_end_time := v_end_time;
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
      session_end_time := NULL;
      RETURN NEXT;
    END IF;
    i := i + 1;
  END LOOP;

  RETURN;
END;
$function$;
