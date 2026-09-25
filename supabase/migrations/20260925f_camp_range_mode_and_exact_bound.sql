-- Three review findings on the camp foundation, and the fix for two of them is
-- a feature that was already built and I had not read: schedule_mode = 'range'.
--
-- A range program is one that runs from a start date to an END DATE, with its
-- session_count DERIVED rather than typed. That is the camp shape exactly. It
-- already has: a preview RPC bounded by the end date
-- (preview_program_range_schedule), a materializer that writes the derived count
-- back to session_count (compute_range_session_count), a save path in
-- ProgramsCalendar that re-materializes on every edit, and a drift notice that
-- tells the operator when a school-calendar change has moved the count. Four
-- after-school programs run in range mode today.
--
-- The ONLY thing range mode cannot do is meet on more than one weekday: it snaps
-- to day_of_week and steps 7. That is the same one-line difference as everywhere
-- else in this build. So a camp is a RANGE program whose class_days lists the
-- days it meets, and the second and third findings stop being code at all.
--
-- ---------------------------------------------------------------------------
-- FINDING 1 (real bug, fixed here): the camp walk was bounded by end_date but
-- still SIZED by session_count.
--
--     v_max_lookups := CASE WHEN v_consecutive THEN v_count * 7 ... END
--
-- Reproduced on staging: a camp running 2026-12-21 to 2027-01-01, Mon-Fri, is
-- ten meeting days across a twelve-day span. With session_count left at 1 the
-- guard computed 7, the loop stopped at i = 7, and the camp silently came back
-- as FIVE days ending 12-25. derive_program_session_schedule truncated
-- identically, and that is the one payroll reads - an instructor working the
-- second week would have had no pay line seeded - while refundFeeProration
-- reads derive_program_session_dates, so a cancellation would have prorated
-- against half a camp.
--
-- The consecutive walk exits on end_date, so its bound is the SPAN, not a count:
--     (end_date - first_session_date) + 1
-- which is exact. Closures add nothing (the walk stops at end_date either way)
-- and a missing or backwards end_date yields <= 0, so the loop does not run and
-- the camp derives no dates rather than a wrong set. The weekly bound is
-- untouched: there the count IS the bound, and closures really do push the last
-- session out, which is why it still carries its closure allowance.
--
-- FINDING 2 (session_count could drift from a camp's real length): fixed by
-- CONSTRUCTION rather than by new code. class_days now requires range mode, so a
-- camp's session_count is always the derived count, written by the same
-- materializer after-school range programs already use, and covered by the drift
-- notice already on screen. Nothing new to keep in step.
--
-- FINDING 3 (preview_program_session_dates steps weekly and ignores class_days):
-- that is the COUNT-mode preview, and the constraint above means a camp is never
-- a count-mode program. It is now unreachable for a camp, so it stays exactly as
-- it is - the weekly function it has always been. The preview a camp needs is
-- the range one, taught about class_days below.
--
-- PROVED INERT. Before this migration, on both databases:
--   staging (133 programs)  dates 7f1af7ddf8c8b970750a3b0514d6f560
--                           schedule b76c6f04a879316047654abe38e62df9
--                           range counts b0ecbfeb3158ba5a2b38a2dfd33ebcfc
--   prod    (131 programs)  dates 707c44e9b95ee44edc799624329bebb1
--                           schedule 12b41051914295cfa0d983e53ef0131e
--                           range counts d08b4577592e2e7bd6cf18345e0caf8f
-- Every branch added here is behind class_days, which is NULL on all 264 rows.

-- ---------------------------------------------------------------------------
-- A camp is a range program.
-- ---------------------------------------------------------------------------

alter table public.programs
  drop constraint if exists programs_class_days_need_range_mode;
alter table public.programs
  add constraint programs_class_days_need_range_mode
  check (class_days is null or schedule_mode is not distinct from 'range');

comment on constraint programs_class_days_need_range_mode on public.programs is
  'A program that runs on consecutive days (class_days set) is a camp, and a camp is defined by its dates, not by a typed session count. Range mode already derives session_count from first_session_date..end_date and re-materializes it on every save, so this constraint is what keeps a camp''s session_count from drifting away from the days it actually runs.';

-- ---------------------------------------------------------------------------
-- FINDING 1: bound the consecutive walk by its span, not by session_count.
-- ---------------------------------------------------------------------------

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

  -- The two walks are bounded by different things, so they are SIZED by
  -- different things. A weekly class is bounded by its session count and a
  -- closure pushes the last session out, so it needs count * 2 plus room for
  -- every closure. A camp is bounded by end_date, so the exact number of steps
  -- is the span in days - closures cannot extend it. Sizing the camp from
  -- session_count is what truncated a ten-day camp to five.
  v_max_lookups := CASE
    WHEN v_consecutive THEN COALESCE(v_end_date - v_first_date, -1) + 1
    ELSE v_count * 2 + COALESCE(array_length(v_all_closures, 1), 0)
  END;

  -- A CAMP STOPS AT ITS LAST DAY. A weekly class carries a closed session
  -- forward - an 8-session term really does run nine weeks when a week is shut -
  -- but a camp is a block families booked by its dates, so a closed day is LOST,
  -- not made up in the following week. programs_class_days_need_end_date makes
  -- end_date mandatory for a camp, so the bound always exists.
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

  -- Same sizing rule as derive_program_session_dates, and it has to be in BOTH:
  -- the first bound fix went into that function only and left this one - the one
  -- PAYROLL reads - still carrying the defect. Span for a camp, count for a
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

-- ---------------------------------------------------------------------------
-- FINDINGS 2 + 3: the range preview learns the same one thing the date walk
-- learned, and the materializer passes it through.
-- ---------------------------------------------------------------------------

-- Adding a parameter makes a new signature rather than replacing the old one,
-- so the 7-argument version is dropped first. Every caller sends named
-- arguments, and p_class_days defaults to NULL, so existing calls resolve to
-- this function unchanged.
drop function if exists public.preview_program_range_schedule(uuid, uuid, text, text, date, date, text);

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
  v_er_weekday  integer;
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

  v_dist_cl := resolve_district_closures(p_organization_id, p_location_id, p_term);

  -- Early-release exceptions resolve against one weekday. A camp spans several,
  -- so it uses the weekday of its first day - the same choice
  -- derive_program_session_dates makes, so the preview and the saved program
  -- cannot disagree.
  v_er_weekday := CASE WHEN v_consecutive THEN EXTRACT(DOW FROM p_start_date)::int ELSE v_weekday END;

  IF COALESCE(btrim(p_early_release_start_time), '') = '' THEN
    v_er_cl := resolve_district_early_release_exceptions(p_organization_id, p_location_id, p_term, v_er_weekday);
  ELSE
    v_er_cl := '{}';
  END IF;

  v_all_cl  := v_loc_cl || v_dist_cl || v_er_cl;

  IF v_consecutive THEN
    -- One day at a time, keeping only the days the camp meets. Bounded by
    -- p_end_date, so a closed day is lost rather than made up - the same rule
    -- the saved camp derives by.
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

-- The dropped function's grants do not survive. It was postgres +
-- authenticated + service_role, with NO execute for public or anon; a
-- CREATE grants execute to PUBLIC by default, and revoking from public does not
-- remove an explicit anon grant, so both are revoked by name and the result is
-- read back after this migration runs.
revoke all on function public.preview_program_range_schedule(uuid, uuid, text, text, date, date, text, text[]) from public;
revoke all on function public.preview_program_range_schedule(uuid, uuid, text, text, date, date, text, text[]) from anon;
grant execute on function public.preview_program_range_schedule(uuid, uuid, text, text, date, date, text, text[]) to authenticated;
grant execute on function public.preview_program_range_schedule(uuid, uuid, text, text, date, date, text, text[]) to service_role;

-- The materializer hands class_days through, so a camp's session_count is
-- derived by exactly the path an after-school range program already uses.
CREATE OR REPLACE FUNCTION public.compute_range_session_count(p_program_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org uuid; v_loc uuid; v_term text; v_dow text; v_start date; v_end date; v_mode text;
  v_er_start text;
  v_class_days text[];
BEGIN
  SELECT organization_id, program_location_id, term, day_of_week, first_session_date, end_date, schedule_mode,
         early_release_start_time, class_days
    INTO v_org, v_loc, v_term, v_dow, v_start, v_end, v_mode, v_er_start, v_class_days
  FROM programs WHERE id = p_program_id;

  IF NOT FOUND OR v_mode IS DISTINCT FROM 'range' THEN
    RETURN NULL;
  END IF;

  RETURN (preview_program_range_schedule(v_org, v_loc, v_term, v_dow, v_start, v_end, v_er_start, v_class_days) ->> 'count')::integer;
END;
$function$;
