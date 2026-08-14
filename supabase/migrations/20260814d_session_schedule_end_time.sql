-- 20260814d_session_schedule_end_time.sql
--
-- derive_program_session_schedule gained session_time in 20260814a. It needs the
-- END time as well, and the reason is a calendar invite: an .ics VEVENT needs
-- DTSTART *and* DTEND, and the confirmation email attaches one event per session
-- date. With only a start, the early-release session either inherits the class's
-- normal end (wrong: it would run past the earlier finish) or falls back to
-- start+1h (also wrong if the class is 45 or 90 minutes).
--
-- Found by gate C2 during self-review: derive_program_session_dates now returns
-- the early-release dates as real sessions, and calendarInvite.ts applied ONE
-- start time to every date in that list -- so a parent's calendar would have said
-- 2:35pm on the one day school let out at 1:20pm. The schedule is the only thing
-- that knows a given date is the exception, so it has to carry both ends of it.
--
-- Return-type change again, so DROP + CREATE again, and
-- programs_with_session_schedule is re-pointed in the same migration -- it builds
-- its own JSON object and would otherwise keep emitting the old key set.
-- Neither is on prod yet, so nothing is being changed under a live reader.

DROP FUNCTION IF EXISTS public.derive_program_session_schedule(uuid);

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
         p.early_release_start_time, p.early_release_end_time
  INTO v_first_date, v_count, v_location_id, v_org_id, v_term, v_start_time, v_end_time,
       v_er_start, v_er_end
  FROM programs p WHERE p.id = p_program_id;

  IF v_first_date IS NULL OR v_count IS NULL OR v_count <= 0 THEN
    RETURN;
  END IF;

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

  v_max_lookups := v_count * 2 + COALESCE(array_length(v_all_closures, 1), 0);

  WHILE v_added < v_count AND i < v_max_lookups LOOP
    v_candidate := v_first_date + (i * 7);
    IF NOT (v_candidate = ANY(v_all_closures)) THEN
      entry_date := v_candidate;
      kind := 'session';
      IF v_opted_in AND v_candidate = ANY(v_er_exceptions_all) THEN
        reason := 'Early release';
        session_time := v_er_start;
        -- NULL, not the class's normal end, when no early-release end was given.
        -- A calendar invite can fall back to a sane default from the start time;
        -- asserting the usual finish would put the class an hour past the early
        -- dismissal, which is the error this whole change exists to remove.
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

COMMENT ON FUNCTION public.derive_program_session_schedule(uuid) IS
  'Full schedule for a program: every meeting date plus every skipped closure with its reason. session_time/session_end_time are when THAT date runs -- the program''s normal times, or its early-release times on a kept early-release date. A kept early-release session carries kind=session with reason=Early release. session_end_time is NULL when the provider gave no early-release end; callers default from the start rather than assume the usual finish.';

GRANT EXECUTE ON FUNCTION public.derive_program_session_schedule(uuid) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.programs_with_session_schedule(p_organization_id uuid, p_term text)
 RETURNS TABLE(program_id uuid, schedule jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p.id,
    COALESCE(
      (SELECT jsonb_agg(
                jsonb_build_object(
                  'date', s.entry_date,
                  'kind', s.kind,
                  'reason', s.reason,
                  'session_time', s.session_time,
                  'session_end_time', s.session_end_time)
                ORDER BY s.entry_date)
       FROM derive_program_session_schedule(p.id) s),
      '[]'::jsonb)
  FROM programs p
  WHERE p.organization_id = p_organization_id
    AND p.term = p_term;
$function$;
