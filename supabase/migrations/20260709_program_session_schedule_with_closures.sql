-- No-school days visible in program schedules (admin / instructor / parent).
--
-- derive_program_session_dates() already SKIPS closures and returns only the
-- real meeting dates, so a no-school day silently vanishes and the schedule
-- shows an unexplained gap. This adds a companion that returns the FULL
-- ordered schedule -- session rows AND the skipped no-school rows (with the
-- district's reason label) -- so every surface can render the closures inline.
--
-- derive_program_session_dates() is left untouched: "which session is the
-- child on" logic must keep counting real meeting dates only.
--
-- Both functions are SECURITY INVOKER (RLS on programs / program_locations /
-- district_calendars applies to the caller), mirroring the existing
-- derive_program_session_dates / programs_with_session_dates grants.

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
  v_location_closures DATE[];
  v_district_closures DATE[];
  v_all_closures      DATE[];
  v_district_reasons  JSONB := '{}'::jsonb;
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

  v_district_closures := resolve_district_closures(v_org_id, v_location_id, v_term);
  v_all_closures := v_location_closures || v_district_closures;

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
      -- district closure -> its reason; location-only closure -> generic label
      reason := COALESCE(v_district_reasons ->> to_char(v_candidate, 'YYYY-MM-DD'), 'No class');
      RETURN NEXT;
    END IF;
    -- NULL v_all_closures (no program_location_id) falls through both branches,
    -- emitting nothing — identical to derive_program_session_dates.
    i := i + 1;
  END LOOP;

  RETURN;
END;
$function$;

-- Batch loader for the term-wide admin calendar view, mirroring
-- programs_with_session_dates. Returns the schedule as an ordered jsonb array
-- so the frontend gets sessions + no-school rows in one round trip.
CREATE OR REPLACE FUNCTION public.programs_with_session_schedule(p_organization_id uuid, p_term text)
RETURNS TABLE(program_id uuid, schedule jsonb)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p.id,
    COALESCE(
      (SELECT jsonb_agg(
                jsonb_build_object('date', s.entry_date, 'kind', s.kind, 'reason', s.reason)
                ORDER BY s.entry_date)
       FROM derive_program_session_schedule(p.id) s),
      '[]'::jsonb)
  FROM programs p
  WHERE p.organization_id = p_organization_id
    AND p.term = p_term;
$function$;

GRANT EXECUTE ON FUNCTION public.derive_program_session_schedule(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.programs_with_session_schedule(uuid, text) TO anon, authenticated, service_role;
