-- 20260717_range_schedule_derivation_v2_weekday.sql
-- Corrects chunk 2: range mode must derive by the CHOSEN day_of_week, not by the
-- start date's weekday. (Found in testing 2026-07-17: a program with day_of_week
-- 'Tuesday' but a first_session_date that lands on a Monday was deriving MONDAY
-- sessions and locking the day read-only -- silently overriding the operator's
-- choice.) The operator picks the weekday; the start date is just the window's
-- earliest edge, and we SNAP forward to the first chosen-weekday on/after it.
--
-- Sorts after 20260717_range_schedule_derivation.sql ("_v2_weekday" > ".sql").

-- Replace the 5-arg preview (start's-weekday version) with a 6-arg version that
-- takes the chosen day_of_week.
DROP FUNCTION IF EXISTS public.preview_program_range_schedule(uuid, uuid, text, date, date);

CREATE OR REPLACE FUNCTION public.preview_program_range_schedule(
  p_organization_id uuid,
  p_location_id     uuid,
  p_term            text,
  p_day_of_week     text,   -- the operator's chosen class weekday ('Tuesday')
  p_start_date      date,   -- window opens on/after this date (any weekday)
  p_end_date        date
) RETURNS jsonb
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
  -- chosen weekday name -> DOW int (Sun=0..Sat=6), matching EXTRACT(DOW).
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
  v_er_cl   := resolve_district_early_release_exceptions(p_organization_id, p_location_id, p_term, v_weekday);
  v_all_cl  := v_loc_cl || v_dist_cl || v_er_cl;

  -- Snap to the first chosen-weekday on/after the start date (<=6 steps).
  v_candidate := p_start_date;
  WHILE EXTRACT(DOW FROM v_candidate) <> v_weekday AND v_guard < 7 LOOP
    v_candidate := v_candidate + 1;
    v_guard := v_guard + 1;
  END LOOP;

  -- Walk weekly across the window; +7 preserves the weekday.
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

GRANT EXECUTE ON FUNCTION public.preview_program_range_schedule(uuid, uuid, text, text, date, date)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.preview_program_range_schedule(uuid, uuid, text, text, date, date) IS
  'Range mode live preview: every occurrence of the CHOSEN day_of_week in [start,end] (snapping forward from start), minus the same closures count mode skips. Returns {count, skipped, first_session, last_session, dates}. Admin-only.';

-- compute passes the program''s chosen day_of_week (its first_session_date is
-- already a real chosen-weekday date once saved, but we drive off day_of_week so
-- recompute is correct even mid-edit).
CREATE OR REPLACE FUNCTION public.compute_range_session_count(p_program_id uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org uuid; v_loc uuid; v_term text; v_dow text; v_start date; v_end date; v_mode text;
BEGIN
  SELECT organization_id, program_location_id, term, day_of_week, first_session_date, end_date, schedule_mode
    INTO v_org, v_loc, v_term, v_dow, v_start, v_end, v_mode
  FROM programs WHERE id = p_program_id;

  IF NOT FOUND OR v_mode IS DISTINCT FROM 'range' THEN
    RETURN NULL;
  END IF;

  RETURN (preview_program_range_schedule(v_org, v_loc, v_term, v_dow, v_start, v_end) ->> 'count')::integer;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.compute_range_session_count(uuid) TO authenticated, service_role;
