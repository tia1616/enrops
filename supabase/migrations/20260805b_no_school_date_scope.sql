-- 20260805b_no_school_date_scope.sql
--
-- Chunk-2 refinement of add_program_no_school_date (20260805a). The operator now
-- CHOOSES whether a marked no-school day is district-wide or just this school,
-- instead of the function auto-deciding by whether the location has a district.
-- Jessica 2026-08-05: a day specific to one school (not the whole district) must
-- be markable school-only; a district holiday still goes district-wide.
--
-- New 4th arg p_scope: 'district' | 'location' | null.
--   'district' -> the district calendar (every program in that district skips it);
--                 requires a district + a school year, else it errors loudly.
--   'location' -> this location's own closure_dates (only this school skips it).
--   null       -> BACK-COMPAT: district when available, else location (exactly the
--                 20260805a behaviour, so a bare 3-arg-style call is unchanged).
--
-- Adding a parameter makes a NEW function signature, so drop the 3-arg version to
-- avoid an ambiguous overload (a 3-arg call would otherwise match both).

DROP FUNCTION IF EXISTS public.add_program_no_school_date(uuid, date, text);

CREATE OR REPLACE FUNCTION public.add_program_no_school_date(
  p_program_id uuid,
  p_date       date,
  p_reason     text DEFAULT NULL,
  p_scope      text DEFAULT NULL
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
  v_scope    text;
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

  IF NOT (public.can_admin_org(v_org) OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'not authorized to change this program''s schedule';
  END IF;

  v_sy := public.term_to_school_year(v_term);

  -- Resolve effective scope. Explicit wins; null falls back to the old auto rule.
  v_scope := lower(COALESCE(
    NULLIF(TRIM(p_scope), ''),
    CASE WHEN v_district IS NOT NULL AND v_sy IS NOT NULL THEN 'district' ELSE 'location' END
  ));

  IF v_scope NOT IN ('district', 'location') THEN
    RAISE EXCEPTION 'scope must be district or location';
  END IF;

  IF v_scope = 'district' THEN
    IF v_district IS NULL OR v_sy IS NULL THEN
      RAISE EXCEPTION 'this program has no district (or its term maps to no school year), so a district-wide no-school day cannot be recorded - mark it for this school instead';
    END IF;
    -- Atomic upsert, dedup by date (see 20260805a).
    INSERT INTO public.district_calendars
      (organization_id, district, school_year, no_school_dates, created_by)
    VALUES
      (v_org, v_district, v_sy,
       jsonb_build_array(jsonb_build_object('date', v_datestr, 'reason', v_reason)),
       auth.uid())
    ON CONFLICT (organization_id, district, school_year) DO UPDATE
    SET no_school_dates = (
          SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
          FROM jsonb_array_elements(district_calendars.no_school_dates) e
          WHERE e->>'date' <> v_datestr
        ) || jsonb_build_array(jsonb_build_object('date', v_datestr, 'reason', v_reason)),
        updated_at = now();
    v_target := 'district';
  ELSE
    IF v_loc IS NULL THEN
      RAISE EXCEPTION 'this program has no location, so there is nowhere to record a no-school day - set a location first';
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

COMMENT ON FUNCTION public.add_program_no_school_date(uuid, date, text, text) IS
  'Marks one date a no-school day for a program. p_scope: district -> district_calendars (whole district skips it, created if absent); location -> this location closure_dates (only this school skips it); null -> district when available else location (20260805a back-compat). Dedups by date. SECURITY DEFINER, owner/admin only via can_admin_org.';

REVOKE ALL ON FUNCTION public.add_program_no_school_date(uuid, date, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.add_program_no_school_date(uuid, date, text, text) TO authenticated;
