-- Hide co-instructor personal contact (email/phone) from a sub who only has a
-- PENDING offer. They can see WHO is on the camp (name + role) to decide whether
-- to accept, but a not-yet-committed instructor shouldn't get the lead/dev's
-- personal cell + email — and someone who declines shouldn't walk away with it.
--
-- Enforced in the SECURITY DEFINER RPC (not just the UI) so the contact can't be
-- pulled via the API either. Split each caller's sessions into "full" (they're a
-- regular instructor OR a confirmed/taught sub → full contact) vs "pending only"
-- (name/role, contact nulled).

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
  full_sessions as (
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
     where s.status in ('confirmed', 'taught')
       and ca.published_at is not null
  ),
  pending_sessions as (
    select distinct ca.camp_session_id
      from assignment_substitutions s
      join camp_assignments ca
        on ca.id = s.parent_assignment_id
       and s.parent_assignment_type = 'camp'
      join me on me.id = s.sub_instructor_id
     where s.status = 'pending'
       and ca.published_at is not null
  ),
  my_sessions as (
    select camp_session_id from full_sessions
    union
    select camp_session_id from pending_sessions
  )
  select ca.camp_session_id, ca.instructor_id,
    btrim(coalesce(nullif(btrim(i.preferred_name), ''), i.first_name, '') || ' ' || coalesce(i.last_name, '')) as name,
    ca.role,
    case when fs.camp_session_id is not null then i.email else null end as email,
    case when fs.camp_session_id is not null then i.phone else null end as phone
  from camp_assignments ca
  join my_sessions ms on ms.camp_session_id = ca.camp_session_id
  left join full_sessions fs on fs.camp_session_id = ca.camp_session_id
  join instructors i on i.id = ca.instructor_id
  cross join me
  where ca.instructor_id <> me.id
    and i.organization_id = me.organization_id
    and ca.published_at is not null
    and ca.status in ('published', 'change_requested', 'confirmed');
$function$;

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
  full_programs as (
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
     where s.status in ('confirmed', 'taught')
       and pa.published_at is not null
  ),
  pending_programs as (
    select distinct pa.program_id
      from assignment_substitutions s
      join program_assignments pa
        on pa.id = s.parent_assignment_id
       and s.parent_assignment_type = 'program'
      join me on me.id = s.sub_instructor_id
     where s.status = 'pending'
       and pa.published_at is not null
  ),
  my_programs as (
    select program_id from full_programs
    union
    select program_id from pending_programs
  )
  select pa.program_id, pa.instructor_id,
    btrim(coalesce(nullif(btrim(i.preferred_name), ''), i.first_name, '') || ' ' || coalesce(i.last_name, '')) as name,
    pa.role,
    case when fp.program_id is not null then i.email else null end as email,
    case when fp.program_id is not null then i.phone else null end as phone
  from program_assignments pa
  join my_programs mp on mp.program_id = pa.program_id
  left join full_programs fp on fp.program_id = pa.program_id
  join instructors i on i.id = pa.instructor_id
  cross join me
  where pa.instructor_id <> me.id
    and i.organization_id = me.organization_id
    and pa.published_at is not null
    and pa.status in ('published', 'change_requested', 'confirmed');
$function$;

revoke all on function public.get_my_program_coinstructors() from public, anon;
grant execute on function public.get_my_program_coinstructors() to authenticated;
