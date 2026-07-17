-- 20260717_revoke_anon_range_fns.sql
-- Least-privilege for the two range-scheduling functions (chunk 2). They were
-- created with a plain GRANT to authenticated/service_role, but Postgres also
-- grants EXECUTE to PUBLIC by default on creation, so anon inherited it. These
-- are admin-only planning tools -- revoke the default PUBLIC/anon grant, matching
-- the established pattern (20260713_revoke_anon_secdef_pickup_earlybird.sql).
--
-- They are SECURITY INVOKER, so RLS already gated the reads (an anon caller could
-- not read another org's programs/locations/calendars) -- this was not a data
-- leak. But: (a) least privilege / advisor hygiene, and (b) an unbounded date
-- range is a cheap anon-callable server loop. Re-grant only the roles that call
-- them: authenticated (admin UI) + service_role (any future server caller).

REVOKE EXECUTE ON FUNCTION public.preview_program_range_schedule(uuid, uuid, text, text, date, date) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.preview_program_range_schedule(uuid, uuid, text, text, date, date) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.compute_range_session_count(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.compute_range_session_count(uuid) TO authenticated, service_role;
