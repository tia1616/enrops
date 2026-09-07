-- The staffing board was slow because of RLS PLAN TIME, not because of work.
--
-- The board and the admin home resolved session dates by calling
-- derive_program_session_dates() once per class from the browser. The obvious
-- diagnosis is N+1 round-trips, and that was my first one. It was wrong, and
-- measuring it is what caught it: a bulk twin that simply looped the existing
-- function came out SLOWER over the wire than 33 parallel calls (2626 ms vs
-- 1987 ms on staging).
--
-- What the numbers actually said, measured as the AUTHENTICATED role - not
-- through a superuser connection, which silently skips RLS and was how I first
-- mismeasured this at 47 ms:
--
--   whole function, one class          92 ms
--     resolve_district_closures        40 ms
--     resolve_district_early_release   33 ms
--     program_locations read            0.9 ms
--
-- and inside the district resolver, for a query returning ZERO rows:
--
--   Planning Time    37.1 ms
--   Execution Time    6.2 ms
--
-- It is the PLANNER. program_locations carries an RLS policy that expands into
-- dozens of nested SubPlans - registrations, camp_sessions, camp_assignments,
-- instructors, org_members, each with their own policies - and the planner walks
-- all of it every time the function is called. Thirty-three classes paid that
-- thirty-three times, which is the ~2 s the operator waited. No index helps: the
-- execution was already 6 ms.
--
-- So this function is SECURITY DEFINER. That is the fix, not an optimisation
-- around one: as definer, the per-class reads are not re-planned against those
-- policies. Measured after the change, same benchmark, same machine:
--
--   per-class, 33 requests   2305 ms   ->   bulk, 1 request   176 ms
--
-- 176 ms is essentially the network round-trip floor (a trivial REST call to the
-- same host measures ~200 ms from here), so the database cost is now noise.
--
-- SECURITY. DEFINER means RLS no longer guards this, so authorization is
-- explicit and is the WHERE clause, not a comment:
--
--   is_org_member(p.organization_id) OR is_platform_admin()
--
-- Both are themselves SECURITY DEFINER, STABLE, and shaped as EXISTS(...) on a
-- positive membership row (is_org_member additionally requires accepted_at IS
-- NOT NULL). EXISTS returns false, never null - so an anonymous caller with no
-- auth.uid() gets false and therefore zero rows. This is deliberately NOT the
-- `auth.uid() is not null AND ...` shape that skips the real check for anon.
--
-- Grants are narrower than the single-row function, which is granted to PUBLIC
-- and anon for the public catalogue. This one is authenticated + service_role.
-- anon is revoked EXPLICITLY because revoking from public does not remove anon's
-- own grant, and proacl is read back on both databases afterwards.
--
-- PROVEN on staging over HTTP before this went to prod, all four:
--   J2S admin  -> own org ids        HTTP 200, 40 rows
--   J2S admin  -> another org's ids  HTTP 200,  0 rows
--   other org's admin -> J2S ids     HTTP 200,  0 rows
--   anon                             HTTP 401, permission denied for function
-- and the output is unchanged: 33 of 33 classes byte-identical to the
-- one-at-a-time results, 0 mismatches - checked again AFTER the switch to
-- DEFINER, because bypassing RLS on the inner reads could have changed answers
-- and silently did not.
--
-- It still CALLS derive_program_session_dates rather than reimplementing it, so
-- calendars, closures, early release and session_count stay in one place.
--
-- The underlying program_locations policy is the real long-term problem - 37 ms
-- to plan affects every reader of that table, not just this one. That is a
-- security-surface change and is deliberately NOT bundled here.

create or replace function public.derive_program_session_dates_bulk(p_program_ids uuid[])
returns table (program_id uuid, session_dates date[])
language sql
stable
security definer
set search_path to 'public','pg_temp'
as $$
  select p.id, public.derive_program_session_dates(p.id)
  from public.programs p
  where p.id = any(p_program_ids)
    and (public.is_org_member(p.organization_id) or public.is_platform_admin())
$$;

comment on function public.derive_program_session_dates_bulk(uuid[]) is
  'Bulk twin of derive_program_session_dates: one round-trip for many classes. SECURITY DEFINER to avoid re-planning the program_locations RLS policy per class (37ms plan / 6ms exec), which was the whole slow load. Authorization is explicit in the WHERE clause: is_org_member OR is_platform_admin, both fail-closed for anon. Calls the single-row function so date logic stays in one place.';

revoke all on function public.derive_program_session_dates_bulk(uuid[]) from public;
revoke all on function public.derive_program_session_dates_bulk(uuid[]) from anon;
grant execute on function public.derive_program_session_dates_bulk(uuid[]) to authenticated;
grant execute on function public.derive_program_session_dates_bulk(uuid[]) to service_role;
