-- 20260601_district_calendars.sql
--
-- District-level school year calendars. One row per (organization, district,
-- school_year) holds the no-school dates and early-release dates that apply
-- to every program_location in that district. Replaces the 4-12x duplication
-- of entering the same closure list per location.
--
-- Closure precedence for an afterschool program:
--   - If program_locations.district matches a district_calendars.district
--     row → use district_calendars.no_school_dates (district-following).
--   - If district is NULL or 'Charter/Private' → use the location's own
--     program_locations.closure_dates (per-location override).
--   - The derive function unions both, so a Charter/Private location whose
--     district text matches a real district calendar will get both (rare,
--     intentional).
--
-- school_year mapping from programs.term (FA26 / WI27 / SP27 → 2026-2027):
--   - FA{YY}  → 20{YY}   to 20{YY+1}
--   - WI{YY}  → 20{YY-1} to 20{YY}
--   - SP{YY}  → 20{YY-1} to 20{YY}
--   - SU{YY}  → no district calendar lookup (camps run on explicit dates)
--
-- Date-with-reason shape (jsonb arrays):
--   [{"date":"2026-11-26","reason":"Thanksgiving"}, ...]
-- The derive function reads only .date. .reason is for UI display
-- (parent emails, instructor schedules, "why is this session skipped").

CREATE TABLE public.district_calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  district text NOT NULL,
  school_year text NOT NULL,
  first_day_of_school date,
  last_day_of_school date,
  no_school_dates jsonb NOT NULL DEFAULT '[]'::jsonb,
  early_release_dates jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_url text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  UNIQUE (organization_id, district, school_year)
);

COMMENT ON TABLE public.district_calendars IS
  'Per-district school year calendars. Source of truth for no-school dates across all locations in a district. derive_program_session_dates() reads from this for district-following locations.';

COMMENT ON COLUMN public.district_calendars.no_school_dates IS
  'jsonb array of {date, reason}. Reason is short label (e.g. "Thanksgiving", "Winter Break"). derive_program_session_dates() reads only the dates; reasons surface in UI when explaining skipped sessions.';

COMMENT ON COLUMN public.district_calendars.early_release_dates IS
  'jsonb array of {date, reason}. Programs still meet but dismissal is earlier. Used to flag instructor heads-ups and parent emails. Not subtracted from session dates.';

-- ──────────────────────────────────────────────────────────────────────
-- RLS + GRANTs, mirroring program_locations
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.district_calendars ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members_manage_district_calendars"
  ON public.district_calendars
  FOR ALL
  USING (is_org_member(organization_id) OR is_platform_admin())
  WITH CHECK (is_org_member(organization_id) OR is_platform_admin());

CREATE POLICY "public_read_district_calendars"
  ON public.district_calendars
  FOR SELECT
  USING (
    organization_id IN (
      SELECT id FROM public.organizations WHERE status = 'active'
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.district_calendars TO authenticated;
GRANT SELECT ON public.district_calendars TO anon;
GRANT ALL ON public.district_calendars TO service_role;

CREATE INDEX district_calendars_org_district_year_idx
  ON public.district_calendars (organization_id, district, school_year);

-- ──────────────────────────────────────────────────────────────────────
-- term → school_year mapper (FA26 → '2026-2027', WI27/SP27 → '2026-2027')
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION term_to_school_year(p_term text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prefix text;
  v_yy     integer;
BEGIN
  IF p_term IS NULL OR length(p_term) < 4 THEN
    RETURN NULL;
  END IF;

  v_prefix := upper(substring(p_term FROM 1 FOR 2));
  BEGIN
    v_yy := substring(p_term FROM 3)::integer;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;

  IF v_prefix = 'FA' THEN
    RETURN format('20%s-20%s', lpad(v_yy::text, 2, '0'), lpad((v_yy + 1)::text, 2, '0'));
  ELSIF v_prefix IN ('WI', 'SP') THEN
    RETURN format('20%s-20%s', lpad((v_yy - 1)::text, 2, '0'), lpad(v_yy::text, 2, '0'));
  ELSE
    -- SU and unknown prefixes have no district school year
    RETURN NULL;
  END IF;
END;
$$;

COMMENT ON FUNCTION term_to_school_year(text) IS
  'Maps programs.term (FA26, WI27, SP27) to district_calendars.school_year (2026-2027). Returns NULL for SU terms and unknown formats.';

GRANT EXECUTE ON FUNCTION term_to_school_year(text) TO authenticated, anon, service_role;

-- ──────────────────────────────────────────────────────────────────────
-- Replace derive_program_session_dates to also subtract district closures
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION derive_program_session_dates(p_program_id UUID)
RETURNS DATE[]
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_first_date    DATE;
  v_count         INTEGER;
  v_location_id   UUID;
  v_location_closures DATE[];
  v_district      TEXT;
  v_org_id        UUID;
  v_term          TEXT;
  v_school_year   TEXT;
  v_district_closures DATE[];
  v_all_closures  DATE[];
  v_result        DATE[] := '{}';
  v_candidate     DATE;
  v_max_lookups   INTEGER;
  v_added         INTEGER := 0;
  i               INTEGER := 0;
BEGIN
  SELECT
    p.first_session_date,
    p.session_count,
    p.program_location_id,
    p.organization_id,
    p.term
  INTO v_first_date, v_count, v_location_id, v_org_id, v_term
  FROM programs p
  WHERE p.id = p_program_id;

  IF v_first_date IS NULL OR v_count IS NULL OR v_count <= 0 THEN
    RETURN '{}';
  END IF;

  SELECT
    COALESCE(pl.closure_dates, '{}'),
    pl.district
  INTO v_location_closures, v_district
  FROM program_locations pl
  WHERE pl.id = v_location_id;

  -- Look up district calendar if location follows a district
  v_school_year := term_to_school_year(v_term);
  IF v_district IS NOT NULL
     AND v_district <> 'Charter/Private'
     AND v_school_year IS NOT NULL THEN
    SELECT COALESCE(
      ARRAY(
        SELECT (elem->>'date')::date
        FROM jsonb_array_elements(dc.no_school_dates) AS elem
        WHERE elem->>'date' IS NOT NULL
      ),
      '{}'::date[]
    )
    INTO v_district_closures
    FROM district_calendars dc
    WHERE dc.organization_id = v_org_id
      AND dc.district = v_district
      AND dc.school_year = v_school_year;
  END IF;

  v_district_closures := COALESCE(v_district_closures, '{}'::date[]);

  -- Union both closure sources (duplicates harmless)
  v_all_closures := v_location_closures || v_district_closures;

  v_max_lookups := v_count * 2 + COALESCE(array_length(v_all_closures, 1), 0);

  WHILE v_added < v_count AND i < v_max_lookups LOOP
    v_candidate := v_first_date + (i * 7);
    IF NOT (v_candidate = ANY(v_all_closures)) THEN
      v_result := v_result || v_candidate;
      v_added := v_added + 1;
    END IF;
    i := i + 1;
  END LOOP;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION derive_program_session_dates(UUID) IS
  'Returns the chronological list of dates a program meets, skipping both location closure_dates and district_calendars.no_school_dates (for district-following locations). Caller RLS gates access via SECURITY INVOKER. Early-release dates are NOT subtracted — programs still meet on those days.';

GRANT EXECUTE ON FUNCTION derive_program_session_dates(UUID) TO authenticated;
