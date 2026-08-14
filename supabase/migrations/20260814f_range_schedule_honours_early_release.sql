-- 20260814f_range_schedule_honours_early_release.sql
--
-- Code-review finding #1 (high), 14 Aug. 20260814a taught THREE date functions
-- that an opted-in program keeps its occasional early-release dates:
-- derive_program_session_dates, preview_program_session_dates and
-- derive_program_session_schedule. It did not teach the RANGE pair, which still
-- subtracts those dates unconditionally.
--
-- WHY THAT BREAKS RATHER THAN JUST DISAGREES. Range mode's whole design rests on
-- the two sides agreeing about which dates are closures: the range preview counts
-- the meetings in the window and that count is MATERIALIZED into
-- programs.session_count, after which derive_program_session_dates walks weekly
-- collecting exactly that many dates. Once the two disagree, the count is short.
--
--   Wednesdays, 9 Sep -> 16 Dec, 3 occasional early-release Wednesdays.
--   preview skips them        -> session_count = 12
--   operator sets 12:45       -> derive no longer skips them
--   derive collects 12 dates  -> stops on 25 Nov, THREE WEEKS before end_date
--
-- The last three sessions vanish from the admin list, the parent dashboard, the
-- instructor portal and the .ics on the confirmation email -- and the chunk-4
-- drift check cannot see it, because compute_range_session_count calls this same
-- function and returns the same short 12.
--
-- Latent rather than live today: on prod only j2s has range programs (2), and
-- neither has an occasional early-release day. It becomes real the first time a
-- range class sits at a district with occasional early release.
--
-- Same DROP-before-CREATE care as 20260814a's preview function: adding a
-- defaulted argument leaves the old 6-arg form matching too, and Postgres
-- refuses the call as ambiguous rather than picking one.

DROP FUNCTION IF EXISTS public.preview_program_range_schedule(uuid, uuid, text, text, date, date);

CREATE OR REPLACE FUNCTION public.preview_program_range_schedule(
  p_organization_id uuid,
  p_location_id uuid,
  p_term text,
  p_day_of_week text,
  p_start_date date,
  p_end_date date,
  p_early_release_start_time text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_weekday   integer;
  v_loc_cl    date[];
  v_dist_cl   date[];
  v_er_cl     date[];
  v_all_cl    date[];
  v_candidate date;
  v_dates     date[] := '{}';
  v_skipped   integer := 0;
  v_guard     integer := 0;
BEGIN
  v_weekday := CASE lower(coalesce(p_day_of_week, ''))
    WHEN 'sunday' THEN 0 WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2
    WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4 WHEN 'friday' THEN 5
    WHEN 'saturday' THEN 6 ELSE NULL END;

  IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date < p_start_date OR v_weekday IS NULL THEN
    RETURN jsonb_build_object('count', 0, 'skipped', 0,
      'first_session', NULL, 'last_session', NULL, 'dates', '[]'::jsonb);
  END IF;

  SELECT COALESCE(pl.closure_dates, '{}') INTO v_loc_cl
  FROM program_locations pl WHERE pl.id = p_location_id;
  v_loc_cl := COALESCE(v_loc_cl, '{}');

  v_dist_cl := resolve_district_closures(p_organization_id, p_location_id, p_term);

  -- THE ONLY BEHAVIOUR CHANGE, and it is the same test 20260814a added to the
  -- other three: an opted-in program keeps these dates, so they are not closures
  -- and must not be subtracted from the count either.
  IF COALESCE(btrim(p_early_release_start_time), '') = '' THEN
    v_er_cl := resolve_district_early_release_exceptions(p_organization_id, p_location_id, p_term, v_weekday);
  ELSE
    v_er_cl := '{}';
  END IF;

  v_all_cl  := v_loc_cl || v_dist_cl || v_er_cl;

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

  RETURN jsonb_build_object(
    'count',         COALESCE(array_length(v_dates, 1), 0),
    'skipped',       v_skipped,
    'first_session', v_dates[1],
    'last_session',  v_dates[array_length(v_dates, 1)],
    'dates',         to_jsonb(v_dates)
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.preview_program_range_schedule(uuid, uuid, text, text, date, date, text) TO authenticated;

-- Reads the override off the row rather than taking it as an argument: this one
-- is called ABOUT a saved program, so the row is the truth. The drift check
-- (chunk 4) goes through here, so it now compares like with like.
CREATE OR REPLACE FUNCTION public.compute_range_session_count(p_program_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org uuid; v_loc uuid; v_term text; v_dow text; v_start date; v_end date; v_mode text;
  v_er_start text;
BEGIN
  SELECT organization_id, program_location_id, term, day_of_week, first_session_date, end_date, schedule_mode,
         early_release_start_time
    INTO v_org, v_loc, v_term, v_dow, v_start, v_end, v_mode, v_er_start
  FROM programs WHERE id = p_program_id;

  IF NOT FOUND OR v_mode IS DISTINCT FROM 'range' THEN
    RETURN NULL;
  END IF;

  RETURN (preview_program_range_schedule(v_org, v_loc, v_term, v_dow, v_start, v_end, v_er_start) ->> 'count')::integer;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.compute_range_session_count(uuid) TO authenticated;
