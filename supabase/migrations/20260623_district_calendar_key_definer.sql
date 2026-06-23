-- 20260623_district_calendar_key_definer.sql
--
-- Part of the Schools & Partners redesign. Follow-up to
-- 20260623_centralize_session_date_resolution.sql.
--
-- WHY
-- derive_program_session_dates() is called by PARENTS (the family Dashboard),
-- who are authenticated but are NOT org_members. The centralized resolver
-- reads districts.calendar_key to bridge a formalized district to its already-
-- uploaded calendar (match branch 2). But the `districts` table is members-only
-- (RLS policy org_access_districts = check_org_access), so a parent reads zero
-- rows there. Result once district_id is populated: if a calendar is bridged
-- ONLY by calendar_key, a parent's derived schedule would silently skip fewer
-- holidays than the admin's. A program's schedule must be identical for every
-- caller. Verified live: member sees the districts row, parent sees 0.
--
-- FIX (surgical, minimal security-posture change)
-- Keep matching_district_calendars SECURITY INVOKER — program_locations and
-- district_calendars both have public_read, so parents already see those. Only
-- the calendar_key lookup needs elevation, so move JUST that into a tiny
-- SECURITY DEFINER helper that returns ONLY the calendar_key string (never the
-- districts PII: flyer_notes, gatekeeper contacts, etc.). calendar_key is a
-- non-sensitive matching code, and district_calendars holidays are already
-- public_read, so this exposes nothing new.
--
-- BACKWARD COMPATIBLE: district_id is unpopulated everywhere, so
-- district_calendar_key() is only ever called with NULL today (returns NULL),
-- and derive output stays byte-identical for J2S.

-- ──────────────────────────────────────────────────────────────────────
-- SECURITY DEFINER scalar: a district's calendar_key, readable by any caller
-- that can run the date math (incl. parents). Returns only the matching code.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION district_calendar_key(p_district_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
  SELECT calendar_key FROM districts WHERE id = p_district_id;
$func$;

COMMENT ON FUNCTION district_calendar_key(UUID) IS
  'Returns ONLY districts.calendar_key for a district id. SECURITY DEFINER so the date math is role-independent (parents are not org_members and cannot read districts directly). Exposes no districts PII — calendar_key is a non-sensitive matching code and district_calendars holidays are already public_read.';

-- Least privilege. Supabase's default privileges auto-grant EXECUTE to anon on
-- new public functions, and REVOKE FROM public does NOT remove that direct anon
-- grant — so revoke anon explicitly. The date math is authenticated-only
-- (parents + admins); anon never runs derive.
REVOKE EXECUTE ON FUNCTION district_calendar_key(UUID) FROM public, anon;
GRANT EXECUTE ON FUNCTION district_calendar_key(UUID) TO authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────
-- Re-point the single source of truth at the DEFINER helper. Still INVOKER:
-- every TABLE read stays under the caller's RLS; only the calendar_key string
-- is resolved via the elevated helper.
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
      WHERE pl.id = p_location_id
        AND (
          -- 1. structured, direct link
          (pl.district_id IS NOT NULL AND dc.district_id = pl.district_id)
          -- 2. structured, via the district's calendar_key (role-independent)
          OR (dc.district = district_calendar_key(pl.district_id))
          -- 3. legacy free-text district code
          OR (pl.district IS NOT NULL AND dc.district = pl.district)
        )
    );
$func$;
