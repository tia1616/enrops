-- 20260601_programs_with_session_dates.sql
--
-- Batch helper: derive session dates for every program in a (org, term) at
-- once, so the admin UI doesn't fire N RPCs to fill a Scheduled-Programs page.
-- Wraps derive_program_session_dates(), which already gates on RLS via
-- SECURITY INVOKER — this wrapper inherits that gating.

CREATE OR REPLACE FUNCTION programs_with_session_dates(
  p_organization_id uuid,
  p_term text
)
RETURNS TABLE(program_id uuid, session_dates date[])
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $func$
  SELECT p.id, derive_program_session_dates(p.id)
  FROM programs p
  WHERE p.organization_id = p_organization_id
    AND p.term = p_term;
$func$;

COMMENT ON FUNCTION programs_with_session_dates(uuid, text) IS
  'Returns derived session dates for every program in the given (organization_id, term). One round-trip alternative to calling derive_program_session_dates() per program. Caller RLS via SECURITY INVOKER.';

GRANT EXECUTE ON FUNCTION programs_with_session_dates(uuid, text) TO authenticated;
