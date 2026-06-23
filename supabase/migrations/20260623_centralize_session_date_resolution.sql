-- 20260623_centralize_session_date_resolution.sql
--
-- Part of the Schools & Partners redesign. This is the deferred "backward-
-- compatible date read" step promised in 20260623_districts_entity.sql
-- ("Nothing reads district_id for date math yet — that change comes in a
-- later, separately-verified step").
--
-- MUST run AFTER 20260623_districts_entity.sql (needs the districts table,
-- districts.calendar_key, program_locations.district_id and
-- district_calendars.district_id).
--
-- WHAT THIS DOES
-- The rule for "which district calendar(s) apply to a school" used to be
-- copy-pasted in FOUR places (derive_program_session_dates, the wizard's live
-- date preview preview_program_session_dates, the wizard's "no calendar"
-- warning, and the programs-calendar coverage flag). To add the structured
-- district_id link to the date math we centralize that rule into ONE function
-- so the four surfaces can never drift apart again.
--
--   matching_district_calendars(org, location_id, term)
--     The single source of truth. Returns every district_calendars row that
--     applies to a location, matched (UNION — operator's chosen behavior) by:
--       1. structured, direct:  dc.district_id = pl.district_id
--       2. structured, via key: dc.district    = districts.calendar_key
--       3. legacy free-text:    dc.district    = pl.district
--     Union (not "structured wins") so a closure can never be silently lost
--     during the transition; the formalize-district flow reuses the existing
--     calendar_key so branches 2 and 3 resolve to the SAME calendar (deduped).
--
--   resolve_district_closures(org, location_id, term) -> date[]
--     The no-school dates from those calendars. Used by derive + preview.
--
--   program_locations_calendar_coverage(org, term)
--     Batch (location_id, has_district, has_calendar) for the programs-calendar
--     "holidays not subtracted" flag — structure-aware, one query for the page.
--
-- BACKWARD COMPATIBLE / SAFE FOR THE LIVE TENANT
--   program_locations.district_id is unpopulated in every environment (verified
--   0 rows, staging + prod), so branches 1 and 2 contribute nothing today and
--   every program resolves exactly as before via branch 3. derive output is
--   byte-identical for J2S until a district is formalized + linked.

-- ──────────────────────────────────────────────────────────────────────
-- Single source of truth: which calendars apply to a location?
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION matching_district_calendars(
  p_org_id UUID,
  p_location_id UUID,
  p_term TEXT
)
RETURNS SETOF district_calendars
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $func$
  SELECT dc.*
  FROM district_calendars dc
  WHERE p_location_id IS NOT NULL
    AND dc.organization_id = p_org_id
    AND dc.school_year = term_to_school_year(p_term)
    AND EXISTS (
      SELECT 1
      FROM program_locations pl
      LEFT JOIN districts d ON d.id = pl.district_id
      WHERE pl.id = p_location_id
        AND (
          (pl.district_id IS NOT NULL AND dc.district_id = pl.district_id)
          OR (d.calendar_key IS NOT NULL AND dc.district = d.calendar_key)
          OR (pl.district IS NOT NULL AND dc.district = pl.district)
        )
    );
$func$;

COMMENT ON FUNCTION matching_district_calendars(UUID, UUID, TEXT) IS
  'Single source of truth for which district_calendars rows apply to a program_location for a term. Matches by structured district_id link (direct or via districts.calendar_key) UNIONed with the legacy free-text pl.district. SECURITY INVOKER — caller RLS gates access. Used by resolve_district_closures + the admin calendar-coverage flag.';

GRANT EXECUTE ON FUNCTION matching_district_calendars(UUID, UUID, TEXT) TO authenticated;

-- ──────────────────────────────────────────────────────────────────────
-- The no-school dates from those calendars (used by derive + preview)
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION resolve_district_closures(
  p_org_id UUID,
  p_location_id UUID,
  p_term TEXT
)
RETURNS DATE[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $func$
  SELECT COALESCE(
    ARRAY(
      SELECT (elem->>'date')::date
      FROM matching_district_calendars(p_org_id, p_location_id, p_term) dc
      CROSS JOIN LATERAL jsonb_array_elements(dc.no_school_dates) AS elem
      WHERE elem->>'date' IS NOT NULL
    ),
    '{}'::date[]
  );
$func$;

COMMENT ON FUNCTION resolve_district_closures(UUID, UUID, TEXT) IS
  'Union of no-school dates across every district calendar that applies to a location (see matching_district_calendars). Shared by derive_program_session_dates + preview_program_session_dates so saved and previewed dates can never diverge.';

GRANT EXECUTE ON FUNCTION resolve_district_closures(UUID, UUID, TEXT) TO authenticated;

-- ──────────────────────────────────────────────────────────────────────
-- Batch calendar-coverage flag for the admin programs-calendar page
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION program_locations_calendar_coverage(
  p_org_id UUID,
  p_term TEXT
)
RETURNS TABLE(location_id UUID, has_district BOOLEAN, has_calendar BOOLEAN)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $func$
  SELECT
    pl.id,
    (pl.district IS NOT NULL OR pl.district_id IS NOT NULL) AS has_district,
    EXISTS (SELECT 1 FROM matching_district_calendars(p_org_id, pl.id, p_term)) AS has_calendar
  FROM program_locations pl
  WHERE pl.organization_id = p_org_id;
$func$;

COMMENT ON FUNCTION program_locations_calendar_coverage(UUID, TEXT) IS
  'Per-location (has_district, has_calendar) for a term, structure-aware via matching_district_calendars. Powers the admin "holidays not subtracted" warning so a structurally-linked school is not falsely flagged as missing a calendar.';

GRANT EXECUTE ON FUNCTION program_locations_calendar_coverage(UUID, TEXT) TO authenticated;

-- ──────────────────────────────────────────────────────────────────────
-- Rewire derive_program_session_dates to use the shared resolver
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION derive_program_session_dates(p_program_id UUID)
RETURNS DATE[]
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_first_date    DATE;
  v_count         INTEGER;
  v_location_id   UUID;
  v_org_id        UUID;
  v_term          TEXT;
  v_location_closures DATE[];
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

  SELECT COALESCE(pl.closure_dates, '{}')
  INTO v_location_closures
  FROM program_locations pl
  WHERE pl.id = v_location_id;

  v_district_closures := resolve_district_closures(v_org_id, v_location_id, v_term);

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
$func$;

COMMENT ON FUNCTION derive_program_session_dates(UUID) IS
  'Returns the chronological list of dates a program meets, skipping location closure_dates and the district no-school dates from resolve_district_closures() (structured district_id link + legacy free-text, unioned). Backward-compatible: with district_id unpopulated, only the legacy path fires. SECURITY INVOKER — caller RLS gates access. Early-release dates are NOT subtracted.';

GRANT EXECUTE ON FUNCTION derive_program_session_dates(UUID) TO authenticated;

-- ──────────────────────────────────────────────────────────────────────
-- Rewire preview_program_session_dates (wizard live preview) to match derive
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION preview_program_session_dates(
  p_organization_id UUID,
  p_location_id UUID,
  p_term TEXT,
  p_first_date DATE,
  p_count INTEGER
)
RETURNS DATE[]
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_location_closures DATE[] := '{}';
  v_district_closures DATE[] := '{}';
  v_all_closures      DATE[];
  v_result            DATE[] := '{}';
  v_candidate         DATE;
  v_max_lookups       INTEGER;
  v_added             INTEGER := 0;
  i                   INTEGER := 0;
BEGIN
  IF p_first_date IS NULL OR p_count IS NULL OR p_count <= 0 THEN
    RETURN '{}';
  END IF;

  IF p_location_id IS NOT NULL THEN
    SELECT COALESCE(pl.closure_dates, '{}')
    INTO v_location_closures
    FROM program_locations pl
    WHERE pl.id = p_location_id;
  END IF;

  v_district_closures := resolve_district_closures(p_organization_id, p_location_id, p_term);

  v_all_closures := v_location_closures || v_district_closures;
  v_max_lookups := p_count * 2 + COALESCE(array_length(v_all_closures, 1), 0);

  WHILE v_added < p_count AND i < v_max_lookups LOOP
    v_candidate := p_first_date + (i * 7);
    IF NOT (v_candidate = ANY(v_all_closures)) THEN
      v_result := v_result || v_candidate;
      v_added := v_added + 1;
    END IF;
    i := i + 1;
  END LOOP;

  RETURN v_result;
END;
$func$;

COMMENT ON FUNCTION preview_program_session_dates(UUID, UUID, TEXT, DATE, INTEGER) IS
  'Live wizard preview of session dates for an UNSAVED program. Shares resolve_district_closures() with derive_program_session_dates() so the preview always matches the dates the saved program will get.';

GRANT EXECUTE ON FUNCTION preview_program_session_dates(UUID, UUID, TEXT, DATE, INTEGER) TO authenticated;
