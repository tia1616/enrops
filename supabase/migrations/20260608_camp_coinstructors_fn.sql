-- 2026-06-08 — Instructors need to see who they're co-teaching each camp with
-- (e.g. a lead seeing their developing instructor, and vice-versa). camp_assignments
-- RLS scopes instructors to their OWN rows only (instructor_self_assignments_read),
-- so a co-instructor's row + name are RLS-blocked. This SECURITY DEFINER function
-- returns ONLY the names + roles of other instructors on camp_sessions where the
-- caller themselves holds a live published assignment. Names only — no email/phone.
--
-- Self-scoping gate: auth.uid() -> instructors.me -> my_sessions. The caller can
-- never see co-instructors for a session they aren't on, and never crosses orgs.
-- Locked to `authenticated` (revoked from public/anon) per the SECURITY DEFINER
-- grants rule — the function self-checks, so any authenticated instructor is safe.
create or replace function public.get_my_camp_coinstructors()
returns table (
  camp_session_id uuid,
  instructor_id uuid,
  name text,
  role text
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
    ca.role
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
