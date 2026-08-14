-- 20260814g_er_choice_returns_schedule_mode.sql
--
-- Two code-review findings in one function, because both live here.
--
-- FINDING #2 (second half). EarlyReleaseChoice writes the two early-release
-- columns directly and never recomputes session_count. A RANGE program
-- MATERIALIZES that count, so turning the early-release dates back into meetings
-- without re-deriving it leaves the row asserting N-k sessions while the dates
-- say N -- and the schedule then stops k weeks short. Returning schedule_mode
-- lets that screen re-derive the count for exactly the rows that need it and
-- leave count-mode programs alone, where the count is what the operator typed.
--
-- FINDING #5 (efficiency). resolve_district_early_release_exceptions appeared in
-- BOTH the select list and the WHERE clause, so the resolver -- which loops over
-- every matching district calendar and unnests its date arrays -- ran twice for
-- every candidate program. For 21 programs at one district that is 42 calendar
-- scans instead of 21, on an RPC that fires immediately after every calendar
-- save. Now resolved once per row in a LATERAL and filtered on that.
--
-- Return-type change (new schedule_mode column), so DROP + CREATE.
-- Behaviour is otherwise identical: same rows, same order, same tenant guard.

DROP FUNCTION IF EXISTS public.programs_needing_early_release_choice(uuid, uuid, text);

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
  schedule_mode TEXT,
  exception_count INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $func$
BEGIN
  -- Explicit tenant guard on top of RLS, so the intent is readable rather than
  -- implied, and it fails closed if the policy on programs is ever loosened.
  IF p_org_id IS NULL OR NOT (is_org_member(p_org_id) OR is_platform_admin()) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    p.id, pl.name, p.curriculum, p.term, p.day_of_week,
    p.start_time, p.end_time,
    p.early_release_start_time, p.early_release_end_time,
    p.schedule_mode,
    er.n::int
  FROM programs p
  JOIN program_locations pl ON pl.id = p.program_location_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(array_length(
      resolve_district_early_release_exceptions(
        p.organization_id, p.program_location_id, p.term,
        EXTRACT(DOW FROM p.first_session_date)::int
      ), 1), 0) AS n
  ) er
  WHERE p.organization_id = p_org_id
    AND p.first_session_date IS NOT NULL
    AND COALESCE(p.status, '') NOT IN ('cancelled', 'archived')
    -- district_id is the structured link; the free-text column is the legacy one
    -- that predates districts existing, and calendars still match on it. Both are
    -- accepted so a provider who has not re-linked their schools still gets asked.
    AND (
      (p_district_id IS NOT NULL AND pl.district_id = p_district_id)
      OR (p_district_text IS NOT NULL AND NULLIF(btrim(p_district_text), '') IS NOT NULL
          AND btrim(lower(pl.district)) = btrim(lower(p_district_text)))
    )
    AND er.n > 0
  ORDER BY pl.name, p.start_time NULLS LAST, p.curriculum;
END;
$func$;

COMMENT ON FUNCTION public.programs_needing_early_release_choice(UUID, UUID, TEXT) IS
  'Programs at a district''s schools with at least one OCCASIONAL early-release date on their weekday, with current times, schedule_mode and the exception count. Read-only.';

GRANT EXECUTE ON FUNCTION public.programs_needing_early_release_choice(UUID, UUID, TEXT) TO authenticated;
