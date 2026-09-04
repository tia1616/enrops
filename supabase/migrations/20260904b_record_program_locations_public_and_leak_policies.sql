-- RECORD-ONLY. This migration exists to close a git/ledger gap, not to change
-- behaviour. It is a NO-OP on staging and production, by construction.
--
-- THE GAP. public.program_locations_public and the two "leak" policies on
-- public.program_locations are LIVE on both databases and have been since
-- 25 Aug, but their migration files were never merged: they sat on the branch
-- feat/sites-leak (20260817b "..._public_and_instructor_read" and 20260817c
-- "..._public_add_area"), which was deleted on 2026-09-04 after triage found
-- every one of its objects already applied. Neither file is in either
-- environment's supabase_migrations ledger.
--
-- WHY IT MATTERS. Nothing is broken today. But an environment rebuilt from the
-- migrations directory - a new staging, a disaster-recovery restore, a local
-- stack - would come up WITHOUT the public catalogue view and without the
-- instructor/parent read policies. Every registration page would render an
-- empty school list and no instructor or parent would see their own site.
--
-- WHY EVERY STATEMENT IS GUARDED. On staging and prod these objects exist, so
-- each guard is false and nothing runs: no lock is taken on a live view that
-- the public catalogue reads, and no policy on a live table is dropped and
-- re-created even for an instant. On a fresh database the guards are true and
-- the objects are created. Verified after applying: the view definition and
-- both policy expressions are byte-identical to what they were before.
--
-- security_invoker IS DELIBERATELY false, and that is not the 4 Sept bug.
-- Reads through this view are MEANT to bypass row-level rules: it is the public
-- catalogue, and a logged-out family has to be able to find a school before
-- they can register at it. What was wrong on 4 Sept was that anon and
-- authenticated also held INSERT/UPDATE/DELETE on it, so WRITES bypassed the
-- rules too. That was revoked in 20260904a. Do not "fix" this to true - it
-- would return zero rows to an anonymous visitor and blank every registration
-- page. The write grants are the thing to keep revoked.
--
-- Definitions below were dumped from PRODUCTION on 2026-09-04
-- (pg_get_viewdef / pg_policies), not written from memory.

do $$
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'program_locations_public'
  ) then
    execute $v$
      create view public.program_locations_public
        with (security_invoker = false) as
        select id, organization_id, name, address, district, district_id, area
          from public.program_locations
         where organization_id in (select id from public.public_org_directory)
    $v$;
    -- Match the grants 20260904a leaves in place: read only, never write.
    execute 'grant select on public.program_locations_public to anon, authenticated';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'program_locations'
       and policyname = 'instructors_read_assigned_locations'
  ) then
    execute $p$
      create policy instructors_read_assigned_locations
        on public.program_locations for select to authenticated
        using (
          exists (
            select 1 from program_assignments pa
              join programs p on p.id = pa.program_id
             where p.program_location_id = program_locations.id
               and pa.instructor_id = private.current_instructor_id()
               and pa.status = any (array['published','change_requested','confirmed'])
          )
          or exists (
            select 1 from camp_assignments ca
              join camp_sessions cs on cs.id = ca.camp_session_id
             where cs.location_id = program_locations.id
               and ca.instructor_id = private.current_instructor_id()
               and ca.status = any (array['published','change_requested','confirmed'])
          )
        )
    $p$;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'program_locations'
       and policyname = 'parents_read_enrolled_locations'
  ) then
    execute $p$
      create policy parents_read_enrolled_locations
        on public.program_locations for select to authenticated
        using (
          exists (
            select 1 from registrations r
              join programs p on p.id = r.program_id
             where p.program_location_id = program_locations.id
               and r.parent_id = current_parent_id()
          )
          or exists (
            select 1 from registrations r
              join camp_sessions cs on cs.id = r.camp_session_id
             where cs.location_id = program_locations.id
               and r.parent_id = current_parent_id()
          )
        )
    $p$;
  end if;
end $$;
