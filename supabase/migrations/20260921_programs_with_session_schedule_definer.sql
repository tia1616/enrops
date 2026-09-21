-- Scheduled programs took 4.6 SECONDS to load for Journey to STEAM. This makes it ~100ms.
--
-- WHERE THE TIME WENT (measured on prod, not guessed):
--   The same call is 105ms as superuser and 4,601ms as the signed-in owner. That
--   43x gap is not the work, it is ROW SECURITY being re-evaluated.
--   programs_with_session_schedule calls derive_program_session_schedule once per
--   program, and that function internally reads programs, program_locations and
--   the district calendars. Each of those tables carries TWO permissive SELECT
--   policies, and the second one is
--       organization_id IN (SELECT id FROM public_org_directory)
--   - a view over organizations LEFT JOIN org_branding that builds four jsonb
--   objects per row. Permissive policies are OR'd and evaluated per row, so that
--   view was being resolved over and over inside 39 nested function calls.
--
--   The obvious suspect - recomputing shared district data per program - was
--   FALSIFIED before writing this: FA26 has 39 programs across 34 distinct
--   locations, so there is almost nothing to share. The cost is per-call RLS.
--
-- THE FIX: SECURITY DEFINER, so the internal reads happen once as the owner
-- rather than through the policy stack, with an explicit membership check taking
-- over the job RLS was doing. This is the same shape as its sibling
-- derive_program_session_dates_bulk (20260907d), which already does exactly this.
--
-- PROVEN BEFORE SHIPPING, on prod data, inside a rolled-back transaction:
--   - identical output: 39 rows before, 39 rows after, zero rows differing in
--     either direction (EXCEPT both ways on the full row including the jsonb).
--   - 4,601ms -> 102ms for the same signed-in owner.
--   - an owner of a DIFFERENT org gets 0 rows. Note this is a TIGHTENING: the
--     old version returned all 39, because programs carry a public_read policy
--     for the parent-facing catalogue. Nothing relied on that here - the only
--     caller is the admin Scheduled programs page. Parents and instructors read
--     derive_program_session_schedule directly, which is NOT changed by this.
--
-- GRANTS: CREATE OR REPLACE FUNCTION KEEPS the existing ACL, and this function
-- was granted to PUBLIC and to anon. Left alone, making it SECURITY DEFINER
-- would have handed every org's schedule to anon - the 2026-08-20 shape that
-- leaked parent emails. Both are revoked explicitly below, because revoking from
-- PUBLIC does not remove anon's own grant. Read proacl back after applying.

create or replace function public.programs_with_session_schedule(p_organization_id uuid, p_term text)
returns table(program_id uuid, schedule jsonb)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  SELECT p.id,
    COALESCE(
      (SELECT jsonb_agg(
                jsonb_build_object(
                  'date', s.entry_date,
                  'kind', s.kind,
                  'reason', s.reason,
                  'session_time', s.session_time,
                  'session_end_time', s.session_end_time)
                ORDER BY s.entry_date)
       FROM derive_program_session_schedule(p.id) s),
      '[]'::jsonb)
  FROM programs p
  WHERE p.organization_id = p_organization_id
    AND p.term = p_term
    -- Replaces the RLS this function no longer runs under. Does not depend on p,
    -- so it gates the whole call rather than costing anything per row.
    AND (public.is_org_member(p_organization_id) OR public.is_platform_admin());
$function$;

revoke all on function public.programs_with_session_schedule(uuid, text) from public;
revoke all on function public.programs_with_session_schedule(uuid, text) from anon;
grant execute on function public.programs_with_session_schedule(uuid, text) to authenticated, service_role;
