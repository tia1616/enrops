-- 20260805a_add_program_no_school_date.sql
--
-- In-context "skip this date" for a program's schedule. An operator viewing a
-- program's derived dates can mark one a no-school day without hunting for the
-- School calendar page. This records it in the SAME place the derivation reads,
-- so the date actually drops -- the recurring silent-failure trap is writing to
-- a row the derivation never looks at.
--
-- WRITE TARGET mirrors matching_district_calendars() EXACTLY:
--   * If the program's location has a district AND the term maps to a school
--     year (FA/WI/SP -> term_to_school_year), record it on the district calendar
--     row (organization_id, district, school_year) -- creating that row if the
--     operator never set one up. This is Jessica's call: a no-school day is a
--     DISTRICT day off, so every program in that district drops it too, and it's
--     captured for next year. The row keys on the legacy free-text pl.district,
--     which is branch 3 of matching_district_calendars (the only branch that
--     fires for lean ops, whose district_id is unpopulated).
--   * Otherwise (no district on the location, or a SU/unknown term with no
--     school year) fall back to the LOCATION's own closure_dates -- narrower
--     (only that location's programs skip it) but always works, never dead-ends.
--     Approved fallback 2026-08-05.
--
-- Dedup by date so a double-click / re-mark is a no-op, not a duplicate row.
--
-- SECURITY DEFINER + can_admin_org() gate: this write reshapes schedules for
-- every program at the district/location, so it is owner/admin only (the
-- established pattern -- seed_default_waivers, rename_org_slug, etc.). It bypasses
-- RLS, so the org check is enforced in-body. search_path pinned per house rule.

CREATE OR REPLACE FUNCTION public.add_program_no_school_date(
  p_program_id uuid,
  p_date       date,
  p_reason     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org      uuid;
  v_term     text;
  v_loc      uuid;
  v_district text;
  v_sy       text;
  v_reason   text := COALESCE(NULLIF(TRIM(p_reason), ''), 'No school');
  v_datestr  text := to_char(p_date, 'YYYY-MM-DD');
  v_cal_id   uuid;
  v_existing jsonb;
  v_target   text;
BEGIN
  IF p_program_id IS NULL OR p_date IS NULL THEN
    RAISE EXCEPTION 'program_id and date are required';
  END IF;

  SELECT p.organization_id, p.term, p.program_location_id, pl.district
    INTO v_org, v_term, v_loc, v_district
  FROM public.programs p
  LEFT JOIN public.program_locations pl ON pl.id = p.program_location_id
  WHERE p.id = p_program_id;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'program not found';
  END IF;

  -- Authorize AFTER loading the row (never trust the caller's claimed org).
  IF NOT (public.can_admin_org(v_org) OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'not authorized to change this program''s schedule';
  END IF;

  v_sy := public.term_to_school_year(v_term);

  IF v_district IS NOT NULL AND v_sy IS NOT NULL THEN
    -- District path (district-wide).
    SELECT id, no_school_dates INTO v_cal_id, v_existing
    FROM public.district_calendars
    WHERE organization_id = v_org AND district = v_district AND school_year = v_sy;

    IF v_cal_id IS NULL THEN
      INSERT INTO public.district_calendars
        (organization_id, district, school_year, no_school_dates, created_by)
      VALUES
        (v_org, v_district, v_sy,
         jsonb_build_array(jsonb_build_object('date', v_datestr, 'reason', v_reason)),
         auth.uid());
    ELSIF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_existing) e WHERE e->>'date' = v_datestr
    ) THEN
      UPDATE public.district_calendars
      SET no_school_dates = v_existing
            || jsonb_build_array(jsonb_build_object('date', v_datestr, 'reason', v_reason)),
          updated_at = now()
      WHERE id = v_cal_id;
    END IF;
    v_target := 'district';

  ELSE
    -- Fallback path (location-only).
    IF v_loc IS NULL THEN
      RAISE EXCEPTION 'this program has no location, so there is nowhere to record a no-school day -- set a location first';
    END IF;
    UPDATE public.program_locations
    SET closure_dates = ARRAY(
          SELECT DISTINCT unnest(COALESCE(closure_dates, '{}'::date[]) || ARRAY[p_date])
        )
    WHERE id = v_loc AND organization_id = v_org;
    v_target := 'location';
  END IF;

  RETURN jsonb_build_object(
    'target', v_target,
    'district', v_district,
    'school_year', v_sy,
    'date', v_datestr,
    'reason', v_reason
  );
END;
$$;

COMMENT ON FUNCTION public.add_program_no_school_date(uuid, date, text) IS
  'Marks one date a no-school day for a program, writing to the SAME place the derivation reads: the district calendar row (org, pl.district, term_to_school_year(term)) when both exist -- created if absent -- else the location closure_dates. Dedups by date. SECURITY DEFINER, owner/admin only via can_admin_org.';

REVOKE ALL ON FUNCTION public.add_program_no_school_date(uuid, date, text) FROM public;
GRANT EXECUTE ON FUNCTION public.add_program_no_school_date(uuid, date, text) TO authenticated;
