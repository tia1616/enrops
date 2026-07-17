-- 20260717_range_schedule_derivation.sql
-- Chunk 2 of range-scheduling: derive the session dates + count for RANGE mode.
--
-- KEY DESIGN: range mode does NOT need its own date-walking engine. The count-mode
-- function derive_program_session_dates() already walks weekly from first_session_date,
-- skipping closures, collecting session_count dates. If we DERIVE the count as
-- "number of non-closure weekday-occurrences in [start, end]" and MATERIALIZE it into
-- programs.session_count, then that exact same walk reproduces exactly the range dates
-- -- because there are precisely that many non-closure weekday-occurrences in the
-- window, so collecting that many from the start lands on the last one <= end_date.
-- So: pricing, payroll, emails, and all 5 existing session-date functions keep working
-- UNCHANGED. The only new logic is counting, and (chunk 4) recomputing on calendar change.
--
-- Range and count skip the SAME no-school days: this reuses resolve_district_closures
-- + resolve_district_early_release_exceptions + program_locations.closure_dates,
-- exactly as derive_program_session_dates does. A range program and a count program at
-- the same location can never disagree about which dates are closures.

-- Core (params-based, for the live wizard/tab preview BEFORE a row is saved).
-- Returns a jsonb summary the UI renders: derived count, how many weekday-occurrences
-- were skipped as no-school days, the real first/last session, and the full date list.
CREATE OR REPLACE FUNCTION public.preview_program_range_schedule(
  p_organization_id uuid,
  p_location_id     uuid,
  p_term            text,
  p_start_date      date,
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
BEGIN
  -- Mirror derive_program_session_dates' empty-guard: missing/invalid window -> empty.
  IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date < p_start_date THEN
    RETURN jsonb_build_object('count', 0, 'skipped', 0,
      'first_session', NULL, 'last_session', NULL, 'dates', '[]'::jsonb);
  END IF;

  -- The class weekday IS the start date's weekday (start = the first class), the
  -- same rule count mode uses (weekday of first_session_date).
  v_weekday := EXTRACT(DOW FROM p_start_date);

  SELECT COALESCE(pl.closure_dates, '{}') INTO v_loc_cl
  FROM program_locations pl WHERE pl.id = p_location_id;
  v_loc_cl := COALESCE(v_loc_cl, '{}');

  v_dist_cl := resolve_district_closures(p_organization_id, p_location_id, p_term);
  v_er_cl   := resolve_district_early_release_exceptions(p_organization_id, p_location_id, p_term, v_weekday);
  v_all_cl  := v_loc_cl || v_dist_cl || v_er_cl;

  -- Walk weekly across the inclusive window. +7 preserves the weekday.
  v_candidate := p_start_date;
  WHILE v_candidate <= p_end_date LOOP
    IF v_candidate = ANY (v_all_cl) THEN
      v_skipped := v_skipped + 1;             -- a no-school day that fell on class day
    ELSE
      v_dates := v_dates || v_candidate;      -- a real meeting date
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

GRANT EXECUTE ON FUNCTION public.preview_program_range_schedule(uuid, uuid, text, date, date)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.preview_program_range_schedule(uuid, uuid, text, date, date) IS
  'Range mode live preview: derives {count, skipped, first_session, last_session, dates} for the window [start,end] on start''s weekday, skipping the same closures as count mode. Admin-only (authenticated); does not read a saved program row.';

-- By-id wrapper: reads a saved RANGE program''s window and returns the derived count.
-- Used to MATERIALIZE session_count on save (chunk 3) and RECOMPUTE on calendar
-- change (chunk 4). Returns NULL for a non-range program so callers leave the
-- operator-entered session_count untouched in count mode.
CREATE OR REPLACE FUNCTION public.compute_range_session_count(p_program_id uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org uuid; v_loc uuid; v_term text; v_start date; v_end date; v_mode text;
BEGIN
  SELECT organization_id, program_location_id, term, first_session_date, end_date, schedule_mode
    INTO v_org, v_loc, v_term, v_start, v_end, v_mode
  FROM programs WHERE id = p_program_id;

  IF NOT FOUND OR v_mode IS DISTINCT FROM 'range' THEN
    RETURN NULL;
  END IF;

  RETURN (preview_program_range_schedule(v_org, v_loc, v_term, v_start, v_end) ->> 'count')::integer;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.compute_range_session_count(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.compute_range_session_count(uuid) IS
  'Derived session count for a saved RANGE program (non-closure weekday-occurrences in [first_session_date, end_date]). NULL for non-range programs. Feeds the session_count materialization + calendar-change recompute.';
