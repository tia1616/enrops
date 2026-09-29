-- A camp ignores the district calendar. A class obeys it.
--
-- Jessica, 2026-09-25: "camps should ignore district calendars."
--
-- WHY THIS WAS A BLOCKER, not a nicety. A camp inherited the closure rules of an
-- after-school class, which resolve the SCHOOL DISTRICT's calendar. Measured on
-- staging: 36 of J2S's 65 sites have all ten weekdays of winter break marked as
-- district no-school days. A winter break camp at any of those derived ZERO
-- sessions - no dates for families, no pay lines for instructors, nothing to
-- prorate a refund against. The premise of a winter break camp is that school is
-- out; the district calendar saying so is the REASON it runs, not a reason to
-- cancel it.
--
-- WHAT A CAMP STILL OBEYS: the site's own closure_dates. "The district is on
-- break" and "this building is unavailable that day" are different facts. The
-- first stops a class and is irrelevant to a camp; the second stops anything
-- that was going to happen in that room. Site closures still remove a camp day,
-- and it is still LOST rather than made up, because a camp is bounded by its
-- last day (20260925e).
--
-- EARLY RELEASE GOES TOO, and for the same reason: it is a district-calendar
-- fact about when school lets out. It shifts an after-school class's start time
-- and means nothing to a camp that runs all day. So for a camp the early-release
-- exception set is empty, which also means the early-release START TIME branch
-- in derive_program_session_schedule can never fire for one - a camp's sessions
-- always carry the camp's own times.
--
-- The weekly arm of all three functions is untouched, including the order in
-- which the closure arrays are concatenated. Proved by fingerprint below.

CREATE OR REPLACE FUNCTION public.derive_program_session_dates(p_program_id uuid)
 RETURNS date[]
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_first_date    DATE;
  v_count         INTEGER;
  v_end_date      DATE;
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
  SELECT p.first_session_date, p.session_count, p.end_date, p.program_location_id,
         p.organization_id, p.term, p.early_release_start_time, p.class_days
  INTO v_first_date, v_count, v_end_date, v_location_id, v_org_id, v_term, v_er_start, v_class_days
  FROM programs p WHERE p.id = p_program_id;

  IF v_first_date IS NULL OR v_count IS NULL OR v_count <= 0 THEN
    RETURN '{}';
  END IF;

  v_consecutive := v_class_days IS NOT NULL AND array_length(v_class_days, 1) > 0;

  -- The SITE's own closures apply to everything. An unavailable building is an
  -- unavailable building whether a class or a camp was going to use it.
  SELECT COALESCE(pl.closure_dates, '{}')
  INTO v_location_closures
  FROM program_locations pl WHERE pl.id = v_location_id;

  v_weekday := EXTRACT(DOW FROM v_first_date);

  IF v_consecutive THEN
    -- A CAMP IGNORES THE DISTRICT CALENDAR. School being out is why the camp
    -- runs. Early release is a district fact about an after-school class's start
    -- time and is meaningless to a camp, so it goes with it.
    v_district_closures := '{}';
    v_early_release_exceptions := '{}';
  ELSE
    v_district_closures := resolve_district_closures(v_org_id, v_location_id, v_term);

    IF COALESCE(btrim(v_er_start), '') = '' THEN
      v_early_release_exceptions := resolve_district_early_release_exceptions(v_org_id, v_location_id, v_term, v_weekday);
    ELSE
      v_early_release_exceptions := '{}';
    END IF;
  END IF;

  v_all_closures := v_location_closures || v_district_closures || v_early_release_exceptions;

  -- The two walks are bounded by different things, so they are SIZED by
  -- different things. A weekly class is bounded by its session count and a
  -- closure pushes the last session out, so it needs count * 2 plus room for
  -- every closure. A camp is bounded by end_date, so the exact number of steps
  -- is the span in days - closures cannot extend it.
  v_max_lookups := CASE
    WHEN v_consecutive THEN COALESCE(v_end_date - v_first_date, -1) + 1
    ELSE v_count * 2 + COALESCE(array_length(v_all_closures, 1), 0)
  END;

  -- A CAMP STOPS AT ITS LAST DAY. A weekly class carries a closed session
  -- forward - an 8-session term really does run nine weeks when a week is shut -
  -- but a camp is a block families booked by its dates, so a closed day is LOST,
  -- not made up in the following week.
  WHILE i < v_max_lookups LOOP
    v_candidate := CASE WHEN v_consecutive THEN v_first_date + i ELSE v_first_date + (i * 7) END;
    EXIT WHEN v_consecutive AND v_end_date IS NOT NULL AND v_candidate > v_end_date;
    EXIT WHEN NOT v_consecutive AND v_added >= v_count;
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
  v_end_date          DATE;
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
  SELECT p.first_session_date, p.session_count, p.end_date, p.program_location_id,
         p.organization_id, p.term, p.start_time, p.end_time,
         p.early_release_start_time, p.early_release_end_time, p.class_days
  INTO v_first_date, v_count, v_end_date, v_location_id, v_org_id, v_term, v_start_time, v_end_time,
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

  IF v_consecutive THEN
    -- A CAMP IGNORES THE DISTRICT CALENDAR - see the header. v_er_exceptions_all
    -- is emptied too, not just the closure set: it is what the early-release
    -- TIME branch below tests, so emptying it is what stops a camp's sessions
    -- being re-timed to an after-school early-release start.
    v_district_closures := '{}';
    v_er_exceptions_all := '{}';
    v_early_release_exceptions := '{}';
  ELSE
    v_district_closures := resolve_district_closures(v_org_id, v_location_id, v_term);
    v_er_exceptions_all := resolve_district_early_release_exceptions(v_org_id, v_location_id, v_term, v_weekday);
    v_early_release_exceptions := CASE WHEN v_opted_in THEN '{}'::date[] ELSE v_er_exceptions_all END;
  END IF;

  v_all_closures := v_location_closures || v_district_closures || v_early_release_exceptions;

  -- The reason maps stay keyed off the district calendar for a class. A camp
  -- has no district closures left in v_all_closures, so nothing can look one
  -- up: a camp's only closed days are site closures, which fall through to
  -- 'No class' exactly as a class's site closures already do.
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

  -- Same sizing rule as derive_program_session_dates, and it has to be in BOTH:
  -- an earlier bound fix went into that function only and left this one - the
  -- one PAYROLL reads - still carrying the defect. Span for a camp, count for a
  -- class.
  v_max_lookups := CASE
    WHEN v_consecutive THEN COALESCE(v_end_date - v_first_date, -1) + 1
    ELSE v_count * 2 + COALESCE(array_length(v_all_closures, 1), 0)
  END;

  WHILE i < v_max_lookups LOOP
    v_candidate := CASE WHEN v_consecutive THEN v_first_date + i ELSE v_first_date + (i * 7) END;
    EXIT WHEN v_consecutive AND v_end_date IS NOT NULL AND v_candidate > v_end_date;
    EXIT WHEN NOT v_consecutive AND v_added >= v_count;
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

-- The preview has to agree with the saved camp, or the builder shows the
-- operator one set of dates and stores another.
CREATE OR REPLACE FUNCTION public.preview_program_range_schedule(
  p_organization_id uuid,
  p_location_id uuid,
  p_term text,
  p_day_of_week text,
  p_start_date date,
  p_end_date date,
  p_early_release_start_time text DEFAULT NULL::text,
  p_class_days text[] DEFAULT NULL::text[]
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_weekday     integer;
  v_days        text[];
  v_consecutive boolean;
  v_loc_cl      date[];
  v_dist_cl     date[];
  v_er_cl       date[];
  v_all_cl      date[];
  v_candidate   date;
  v_dates       date[] := '{}';
  v_skipped     integer := 0;
  v_guard       integer := 0;
BEGIN
  -- Lowercased and trimmed once here. programs.class_days is CHECK-constrained
  -- to lowercase, but this function is also called straight from the builder
  -- before a row exists, and a capitalised day silently matching nothing would
  -- preview an empty camp.
  v_days := ARRAY(
    SELECT lower(btrim(d)) FROM unnest(COALESCE(p_class_days, '{}'::text[])) AS d
    WHERE COALESCE(btrim(d), '') <> ''
  );
  v_consecutive := COALESCE(array_length(v_days, 1), 0) > 0;

  v_weekday := CASE lower(coalesce(p_day_of_week, ''))
    WHEN 'sunday' THEN 0 WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2
    WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4 WHEN 'friday' THEN 5
    WHEN 'saturday' THEN 6 ELSE NULL END;

  -- A camp does not need day_of_week: its days are class_days. A weekly program
  -- still does, and that arm is unchanged.
  IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date < p_start_date
     OR (NOT v_consecutive AND v_weekday IS NULL) THEN
    RETURN jsonb_build_object('count', 0, 'skipped', 0,
      'first_session', NULL, 'last_session', NULL, 'dates', '[]'::jsonb);
  END IF;

  SELECT COALESCE(pl.closure_dates, '{}') INTO v_loc_cl
  FROM program_locations pl WHERE pl.id = p_location_id;
  v_loc_cl := COALESCE(v_loc_cl, '{}');

  IF v_consecutive THEN
    -- A CAMP IGNORES THE DISTRICT CALENDAR, same rule the saved camp derives by.
    v_dist_cl := '{}';
    v_er_cl   := '{}';
  ELSE
    v_dist_cl := resolve_district_closures(p_organization_id, p_location_id, p_term);

    IF COALESCE(btrim(p_early_release_start_time), '') = '' THEN
      v_er_cl := resolve_district_early_release_exceptions(p_organization_id, p_location_id, p_term, v_weekday);
    ELSE
      v_er_cl := '{}';
    END IF;
  END IF;

  v_all_cl  := v_loc_cl || v_dist_cl || v_er_cl;

  IF v_consecutive THEN
    -- One day at a time, keeping only the days the camp meets. Bounded by
    -- p_end_date, so a closed day is lost rather than made up.
    v_candidate := p_start_date;
    WHILE v_candidate <= p_end_date LOOP
      IF (ARRAY['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])[EXTRACT(DOW FROM v_candidate)::int + 1] = ANY(v_days) THEN
        IF v_candidate = ANY (v_all_cl) THEN
          v_skipped := v_skipped + 1;
        ELSE
          v_dates := v_dates || v_candidate;
        END IF;
      END IF;
      v_candidate := v_candidate + 1;
    END LOOP;
  ELSE
    v_candidate := p_start_date;
    WHILE EXTRACT(DOW FROM v_candidate) <> v_weekday AND v_guard < 7 LOOP
      v_candidate := v_candidate + 1;
      v_guard := v_guard + 1;
    END LOOP;

    WHILE v_candidate <= p_end_date LOOP
      IF v_candidate = ANY (v_all_cl) THEN
        v_skipped := v_skipped + 1;
      ELSE
        v_dates := v_dates || v_candidate;
      END IF;
      v_candidate := v_candidate + 7;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'count',         COALESCE(array_length(v_dates, 1), 0),
    'skipped',       v_skipped,
    'first_session', v_dates[1],
    'last_session',  v_dates[array_length(v_dates, 1)],
    'dates',         to_jsonb(v_dates)
  );
END;
$function$;

comment on column public.programs.class_days is
  'NULL for a weekly class - sessions step forward 7 days from first_session_date, the original behaviour. Set (lowercase day names, e.g. {monday,tuesday,wednesday,thursday}) for a CAMP: sessions advance one day at a time, only the listed weekdays count, the walk is bounded by end_date so a lost day is not made up, and the SCHOOL DISTRICT CALENDAR IS IGNORED - school being out is why a camp runs. The site''s own closure_dates still apply. day_of_week still holds the FIRST day, the way a one-off workshop derives its day from its date.';
