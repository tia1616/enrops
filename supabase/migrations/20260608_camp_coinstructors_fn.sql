-- 2026-06-08 — Instructors need to see who they're co-teaching each session with
-- (a lead sees their developing instructor and vice-versa), including each other's
-- contact info so co-teachers can coordinate directly.
--
-- camp_assignments / program_assignments RLS scopes instructors to their OWN rows
-- (instructor_self_*), so a co-instructor's row, name, and contact are RLS-blocked.
-- These SECURITY DEFINER functions return name + email + phone of other instructors
-- ONLY on sessions/programs where the caller themselves holds a live published
-- assignment, and only within the caller's own org.
--
-- Contact info (email/phone) is intentionally exposed here: co-teachers on the same
-- camp legitimately need to reach each other. The self-scoping gate
-- (auth.uid() -> me -> my_sessions/my_programs) is the access basis — a caller can
-- never see co-instructors for a session/program they aren't on, and never crosses
-- orgs. Locked to `authenticated` (revoked from public/anon) per the SECURITY
-- DEFINER grants rule; the functions self-check, so any authenticated caller is safe.

-- Drop first so re-running with an added return column (email/phone) succeeds;
-- Postgres can't change a function's OUT-param row type via CREATE OR REPLACE.
drop function if exists public.get_my_camp_coinstructors();
drop function if exists public.get_my_program_coinstructors();

-- Camps -------------------------------------------------------------------------
create or replace function public.get_my_camp_coinstructors()
returns table (
  camp_session_id uuid,
  instructor_id uuid,
  name text,
  role text,
  email text,
  phone text
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select id, organization_id
    from instructors
    where auth_user_id = auth.uid()
    limit 1
  ),
  my_sessions as (
    select distinct ca.camp_session_id
    from camp_assignments ca
    join me on me.id = ca.instructor_id
    where ca.published_at is not null
      and ca.status in ('published', 'change_requested', 'confirmed')
  )
  select
    ca.camp_session_id,
    ca.instructor_id,
    btrim(
      coalesce(nullif(btrim(i.preferred_name), ''), i.first_name, '')
      || ' ' || coalesce(i.last_name, '')
    ) as name,
    ca.role,
    i.email,
    i.phone
  from camp_assignments ca
  join my_sessions ms on ms.camp_session_id = ca.camp_session_id
  join instructors i on i.id = ca.instructor_id
  cross join me
  where ca.instructor_id <> me.id
    and i.organization_id = me.organization_id
    and ca.published_at is not null
    and ca.status in ('published', 'change_requested', 'confirmed');
$$;

revoke all on function public.get_my_camp_coinstructors() from public, anon;
grant execute on function public.get_my_camp_coinstructors() to authenticated;

-- After-school programs ---------------------------------------------------------
create or replace function public.get_my_program_coinstructors()
returns table (
  program_id uuid,
  instructor_id uuid,
  name text,
  role text,
  email text,
  phone text
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select id, organization_id
    from instructors
    where auth_user_id = auth.uid()
    limit 1
  ),
  my_programs as (
    select distinct pa.program_id
    from program_assignments pa
    join me on me.id = pa.instructor_id
    where pa.published_at is not null
      and pa.status in ('published', 'change_requested', 'confirmed')
  )
  select
    pa.program_id,
    pa.instructor_id,
    btrim(
      coalesce(nullif(btrim(i.preferred_name), ''), i.first_name, '')
      || ' ' || coalesce(i.last_name, '')
    ) as name,
    pa.role,
    i.email,
    i.phone
  from program_assignments pa
  join my_programs mp on mp.program_id = pa.program_id
  join instructors i on i.id = pa.instructor_id
  cross join me
  where pa.instructor_id <> me.id
    and i.organization_id = me.organization_id
    and pa.published_at is not null
    and pa.status in ('published', 'change_requested', 'confirmed');
$$;

revoke all on function public.get_my_program_coinstructors() from public, anon;
grant execute on function public.get_my_program_coinstructors() to authenticated;
