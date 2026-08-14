-- 20260814b_programs_needing_early_release_choice.sql
--
-- Powers the question asked after a district calendar is saved: "you have
-- occasional early-release days -- do you still teach on them?" and the
-- editable list that follows it.
--
-- WHY A FUNCTION AND NOT A CLIENT-SIDE LOOP. Whether a date is an EXCEPTION
-- (occasional) or the location's NORMAL schedule (early release every week all
-- year) is decided by resolve_district_early_release_exceptions, in SQL, per
-- program weekday. Re-implementing that test in the browser would give us two
-- answers to the same question and they would drift -- which is the exact class
-- of bug that made the wizard preview and the saved program disagree before
-- 20260716. One call, one answer, and it is the SAME function the date
-- derivation uses.
--
-- Returns ONLY programs that actually have exceptions, so the screen never asks
-- an operator to set a time on a class that has no early-release day to apply
-- it to. A class on LOSD's consistently-early Thursday is correctly absent:
-- it was never skipped and needs no choice.
--
-- READ-ONLY. Touches no calendar and writes nothing.

CREATE OR REPLACE FUNCTION public.programs_needing_early_release_choice(
  p_org_id UUID,
  p_district_id UUID DEFAULT NULL,
  p_district_text TEXT DEFAULT NULL
)
RETURNS TABLE(
  program_id UUID,
  school_name TEXT,
  curriculum TEXT,
  term TEXT,
  day_of_week TEXT,
  start_time TEXT,
  end_time TEXT,
  early_release_start_time TEXT,
  early_release_end_time TEXT,
  exception_count INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $func$
BEGIN
  -- Explicit tenant guard. RLS on programs already scopes this (SECURITY
  -- INVOKER), so passing another org's id returns nothing anyway -- this makes
  -- that intent readable instead of implied, and fails closed if the policy on
  -- programs is ever loosened.
  IF p_org_id IS NULL OR NOT (is_org_member(p_org_id) OR is_platform_admin()) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    pl.name,
    p.curriculum,
    p.term,
    p.day_of_week,
    p.start_time,
    p.end_time,
    p.early_release_start_time,
    p.early_release_end_time,
    COALESCE(array_length(
      resolve_district_early_release_exceptions(
        p.organization_id, p.program_location_id, p.term,
        EXTRACT(DOW FROM p.first_session_date)::int
      ), 1), 0)::int AS exception_count
  FROM programs p
  JOIN program_locations pl ON pl.id = p.program_location_id
  WHERE p.organization_id = p_org_id
    AND p.first_session_date IS NOT NULL
    AND COALESCE(p.status, '') NOT IN ('cancelled', 'archived')
    -- district_id is the structured link; the free-text column is the legacy
    -- one that predates districts existing, and calendars still match on it.
    -- Both are accepted so a provider who has not re-linked their schools yet
    -- still gets asked.
    AND (
      (p_district_id IS NOT NULL AND pl.district_id = p_district_id)
      OR (p_district_text IS NOT NULL AND NULLIF(btrim(p_district_text), '') IS NOT NULL
          AND btrim(lower(pl.district)) = btrim(lower(p_district_text)))
    )
    AND COALESCE(array_length(
      resolve_district_early_release_exceptions(
        p.organization_id, p.program_location_id, p.term,
        EXTRACT(DOW FROM p.first_session_date)::int
      ), 1), 0) > 0
  ORDER BY pl.name, p.start_time NULLS LAST, p.curriculum;
END;
$func$;

COMMENT ON FUNCTION public.programs_needing_early_release_choice(UUID, UUID, TEXT) IS
  'Programs at a district''s schools that have at least one OCCASIONAL early-release date on their weekday, with each one''s current times and current override. Uses resolve_district_early_release_exceptions so the browser never has to re-decide occasional-vs-normal. Read-only.';

GRANT EXECUTE ON FUNCTION public.programs_needing_early_release_choice(UUID, UUID, TEXT) TO authenticated;
