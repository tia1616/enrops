-- Subs couldn't see the camp they were covering. The instructor portal showed a
-- confirmed sub only "this camp" + "Details coming soon" placeholders, with no
-- roster and no lead-instructor name.
--
-- Root cause: a sub can read their own assignment_substitutions row, but the
-- portal then loads the PARENT assignment (the regular instructor's) to get the
-- camp name, session details, roster, and co-instructors. RLS on camp_assignments
-- (and program_assignments) only lets an instructor read their OWN assignment
-- rows. A sub is never the assigned instructor on the parent, so that read
-- returns nothing.
--
-- This single gap cascades: camp_sessions' self-read policy and the existing
-- subs_read_camp_roster* policies (registrations/students/parents) all EXIST but
-- JOIN camp_assignments internally, so they silently return zero rows too. Grant
-- the sub read of the parent assignment and every downstream policy comes alive.
--
-- Scope: a sub may read ONLY the specific parent assignment(s) they are covering,
-- for pending/confirmed/taught (not declined/missed). Pending is included so an
-- offered sub can see the camp, site details, and lead instructor while deciding
-- whether to accept — everything EXCEPT the roster. The roster stays gated to
-- confirmed/taught by the separate, untouched subs_read_camp_roster* policies, so
-- student PII is only exposed once the sub has actually committed. Same for lead
-- and developing subs — nothing here keys on sub_tier.

-- ── Camps ────────────────────────────────────────────────────────────────────
drop policy if exists instructor_sub_read_camp_assignments on public.camp_assignments;
create policy instructor_sub_read_camp_assignments
  on public.camp_assignments
  for select
  to authenticated
  using (
    id in (
      select s.parent_assignment_id
      from public.assignment_substitutions s
      where s.parent_assignment_type = 'camp'
        and s.sub_instructor_id = private.current_instructor_id()
        and s.status in ('pending', 'confirmed', 'taught')
    )
  );

-- ── After-school programs (parity; identical portal path) ────────────────────
drop policy if exists instructor_sub_read_program_assignments on public.program_assignments;
create policy instructor_sub_read_program_assignments
  on public.program_assignments
  for select
  to authenticated
  using (
    id in (
      select s.parent_assignment_id
      from public.assignment_substitutions s
      where s.parent_assignment_type = 'program'
        and s.sub_instructor_id = private.current_instructor_id()
        and s.status in ('pending', 'confirmed', 'taught')
    )
  );

-- ── Co-instructor lookups: include sessions/programs I'm SUBBING on ──────────
-- These SECURITY DEFINER RPCs feed the "who else is on this camp" line. They
-- previously scoped `my_sessions`/`my_programs` to assignments where the caller
-- is the assigned instructor, so a sub saw no one — not even the lead. Extend
-- the scope to cover confirmed/taught sub days. The final SELECT already returns
-- every OTHER instructor on the session, so a sub sees the lead (and the person
-- whose day they're covering); the client frames those two roles distinctly.

create or replace function public.get_my_camp_coinstructors()
  returns table(camp_session_id uuid, instructor_id uuid, name text, role text, email text, phone text)
  language sql
  stable
  security definer
  set search_path to 'public'
as $function$
  with me as (
    select id, organization_id from instructors where auth_user_id = auth.uid() limit 1
  ),
  my_sessions as (
    select distinct ca.camp_session_id
      from camp_assignments ca
      join me on me.id = ca.instructor_id
     where ca.published_at is not null
       and ca.status in ('published', 'change_requested', 'confirmed')
    union
    select distinct ca.camp_session_id
      from assignment_substitutions s
      join camp_assignments ca
        on ca.id = s.parent_assignment_id
       and s.parent_assignment_type = 'camp'
      join me on me.id = s.sub_instructor_id
     where s.status in ('pending', 'confirmed', 'taught')
       and ca.published_at is not null
  )
  select ca.camp_session_id, ca.instructor_id,
    btrim(coalesce(nullif(btrim(i.preferred_name), ''), i.first_name, '') || ' ' || coalesce(i.last_name, '')) as name,
    ca.role, i.email, i.phone
  from camp_assignments ca
  join my_sessions ms on ms.camp_session_id = ca.camp_session_id
  join instructors i on i.id = ca.instructor_id
  cross join me
  where ca.instructor_id <> me.id
    and i.organization_id = me.organization_id
    and ca.published_at is not null
    and ca.status in ('published', 'change_requested', 'confirmed');
$function$;

-- Re-lock EXECUTE: `create or replace` resets grants and Supabase auto-grants
-- EXECUTE to anon+authenticated by default. Revoke and restore the original
-- authenticated-only lock (see 20260604_lock_anon_executable_definer_fns.sql).
revoke all on function public.get_my_camp_coinstructors() from public, anon;
grant execute on function public.get_my_camp_coinstructors() to authenticated;

create or replace function public.get_my_program_coinstructors()
  returns table(program_id uuid, instructor_id uuid, name text, role text, email text, phone text)
  language sql
  stable
  security definer
  set search_path to 'public'
as $function$
  with me as (
    select id, organization_id from instructors where auth_user_id = auth.uid() limit 1
  ),
  my_programs as (
    select distinct pa.program_id
      from program_assignments pa
      join me on me.id = pa.instructor_id
     where pa.published_at is not null
       and pa.status in ('published', 'change_requested', 'confirmed')
    union
    select distinct pa.program_id
      from assignment_substitutions s
      join program_assignments pa
        on pa.id = s.parent_assignment_id
       and s.parent_assignment_type = 'program'
      join me on me.id = s.sub_instructor_id
     where s.status in ('pending', 'confirmed', 'taught')
       and pa.published_at is not null
  )
  select pa.program_id, pa.instructor_id,
    btrim(coalesce(nullif(btrim(i.preferred_name), ''), i.first_name, '') || ' ' || coalesce(i.last_name, '')) as name,
    pa.role, i.email, i.phone
  from program_assignments pa
  join my_programs mp on mp.program_id = pa.program_id
  join instructors i on i.id = pa.instructor_id
  cross join me
  where pa.instructor_id <> me.id
    and i.organization_id = me.organization_id
    and pa.published_at is not null
    and pa.status in ('published', 'change_requested', 'confirmed');
$function$;

revoke all on function public.get_my_program_coinstructors() from public, anon;
grant execute on function public.get_my_program_coinstructors() to authenticated;
