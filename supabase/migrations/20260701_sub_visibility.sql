-- Substitute-instructor visibility in the instructor portal — end state.
--
-- Problem this fixes: a confirmed sub saw only "this camp" + placeholders, no
-- roster, no lead. RLS let a sub read their own assignment_substitutions row but
-- not the PARENT assignment the portal loaded for camp name/session/roster/
-- co-instructors, and every downstream policy (camp_sessions self-read, the
-- subs_read_camp_roster* policies) joined camp_assignments, so they silently
-- returned nothing too.
--
-- Design (kept minimal-leak + data-minimized):
--   * The sub NEVER reads the raw parent assignment row (it carries the regular
--     instructor's comp + private decline/change notes, and RLS can't hide
--     columns). Instead a SECURITY DEFINER resolver returns only whitelisted
--     display fields.
--   * Roster (kids' medical/emergency PII) is confirmed/taught only AND expires
--     2 days after the sub's day.
--   * Co-instructor names show for pending subs (to decide); personal contact
--     unlocks on confirm.
--   * The polymorphic parent join lives in ONE helper + ONE resolver, not
--     scattered across read paths.
--
-- This supersedes the intermediate 20260701 sub iterations; it is the single
-- source of truth and applies correctly on a fresh DB (after 20260529 creates
-- the original roster policies, which we drop + recreate here).

-- ── Co-instructor lookups (camp + program) ───────────────────────────────────
-- Extended to include sessions/programs the caller SUBS on (so a sub sees the
-- lead + whoever they cover for). Contact (email/phone) is returned only for
-- "full" relationships (regular instructor, or confirmed/taught sub); a
-- pending-only sub gets name + role but no personal contact.
create or replace function public.get_my_camp_coinstructors()
  returns table(camp_session_id uuid, instructor_id uuid, name text, role text, email text, phone text)
  language sql stable security definer set search_path to 'public'
as $function$
  with me as (select id, organization_id from instructors where auth_user_id = auth.uid() limit 1),
  full_sessions as (
    select distinct ca.camp_session_id from camp_assignments ca join me on me.id = ca.instructor_id
     where ca.published_at is not null and ca.status in ('published','change_requested','confirmed')
    union
    select distinct ca.camp_session_id from assignment_substitutions s
      join camp_assignments ca on ca.id = s.parent_assignment_id and s.parent_assignment_type='camp'
      join me on me.id = s.sub_instructor_id
     where s.status in ('confirmed','taught') and ca.published_at is not null
  ),
  pending_sessions as (
    select distinct ca.camp_session_id from assignment_substitutions s
      join camp_assignments ca on ca.id = s.parent_assignment_id and s.parent_assignment_type='camp'
      join me on me.id = s.sub_instructor_id
     where s.status = 'pending' and ca.published_at is not null
  ),
  my_sessions as (select camp_session_id from full_sessions union select camp_session_id from pending_sessions)
  select ca.camp_session_id, ca.instructor_id,
    btrim(coalesce(nullif(btrim(i.preferred_name),''), i.first_name,'') || ' ' || coalesce(i.last_name,'')) as name,
    ca.role,
    case when fs.camp_session_id is not null then i.email else null end as email,
    case when fs.camp_session_id is not null then i.phone else null end as phone
  from camp_assignments ca
  join my_sessions ms on ms.camp_session_id = ca.camp_session_id
  left join full_sessions fs on fs.camp_session_id = ca.camp_session_id
  join instructors i on i.id = ca.instructor_id
  cross join me
  where ca.instructor_id <> me.id and i.organization_id = me.organization_id
    and ca.published_at is not null and ca.status in ('published','change_requested','confirmed');
$function$;
revoke all on function public.get_my_camp_coinstructors() from public, anon;
grant execute on function public.get_my_camp_coinstructors() to authenticated;

create or replace function public.get_my_program_coinstructors()
  returns table(program_id uuid, instructor_id uuid, name text, role text, email text, phone text)
  language sql stable security definer set search_path to 'public'
as $function$
  with me as (select id, organization_id from instructors where auth_user_id = auth.uid() limit 1),
  full_programs as (
    select distinct pa.program_id from program_assignments pa join me on me.id = pa.instructor_id
     where pa.published_at is not null and pa.status in ('published','change_requested','confirmed')
    union
    select distinct pa.program_id from assignment_substitutions s
      join program_assignments pa on pa.id = s.parent_assignment_id and s.parent_assignment_type='program'
      join me on me.id = s.sub_instructor_id
     where s.status in ('confirmed','taught') and pa.published_at is not null
  ),
  pending_programs as (
    select distinct pa.program_id from assignment_substitutions s
      join program_assignments pa on pa.id = s.parent_assignment_id and s.parent_assignment_type='program'
      join me on me.id = s.sub_instructor_id
     where s.status = 'pending' and pa.published_at is not null
  ),
  my_programs as (select program_id from full_programs union select program_id from pending_programs)
  select pa.program_id, pa.instructor_id,
    btrim(coalesce(nullif(btrim(i.preferred_name),''), i.first_name,'') || ' ' || coalesce(i.last_name,'')) as name,
    pa.role,
    case when fp.program_id is not null then i.email else null end as email,
    case when fp.program_id is not null then i.phone else null end as phone
  from program_assignments pa
  join my_programs mp on mp.program_id = pa.program_id
  left join full_programs fp on fp.program_id = pa.program_id
  join instructors i on i.id = pa.instructor_id
  cross join me
  where pa.instructor_id <> me.id and i.organization_id = me.organization_id
    and pa.published_at is not null and pa.status in ('published','change_requested','confirmed');
$function$;
revoke all on function public.get_my_program_coinstructors() from public, anon;
grant execute on function public.get_my_program_coinstructors() to authenticated;

-- ── Whitelisted resolver: the ONLY parent read a sub gets ────────────────────
-- Returns, per sub the caller owns (pending/confirmed/taught), exactly the
-- display fields the portal needs — never the comp/notes on the parent row.
create or replace function public.get_my_sub_details()
  returns table(substitution_id uuid, parent_assignment_type text, parent_assignment_id uuid, covered_instructor_id uuid, session jsonb, location jsonb)
  language sql stable security definer set search_path to 'public'
as $function$
  with me as (select id from instructors where auth_user_id = auth.uid() limit 1)
  select s.id, 'camp', s.parent_assignment_id, ca.instructor_id,
    jsonb_build_object('id',cs.id,'curriculum_id',cs.curriculum_id,'curriculum_name',cs.curriculum_name,
      'location_name',cs.location_name,'location_id',cs.location_id,'starts_on',cs.starts_on,'ends_on',cs.ends_on,
      'start_time',cs.start_time,'end_time',cs.end_time,'week_num',cs.week_num,'current_enrollment',cs.current_enrollment),
    case when pl.id is not null then jsonb_build_object('name',pl.name,'address',pl.address,'contact_phone',pl.contact_phone,
      'room_number',pl.room_number,'arrival_instructions',pl.arrival_instructions,'dismissal_instructions',pl.dismissal_instructions) else null end
  from assignment_substitutions s
  join me on me.id = s.sub_instructor_id
  join camp_assignments ca on ca.id = s.parent_assignment_id and s.parent_assignment_type='camp'
  join camp_sessions cs on cs.id = ca.camp_session_id
  left join program_locations pl on pl.id = cs.location_id
  where s.status in ('pending','confirmed','taught') and ca.published_at is not null
  union all
  select s.id, 'program', s.parent_assignment_id, pa.instructor_id,
    jsonb_build_object('id',pr.id,'curriculum',pr.curriculum,'curriculum_id',pr.curriculum_id,'day_of_week',pr.day_of_week,
      'start_time',pr.start_time,'end_time',pr.end_time,'session_count',pr.session_count,'program_location_id',pr.program_location_id),
    case when pl.id is not null then jsonb_build_object('name',pl.name,'address',pl.address,'contact_phone',pl.contact_phone,
      'room_number',pl.room_number,'arrival_instructions',pl.arrival_instructions,'dismissal_instructions',pl.dismissal_instructions) else null end
  from assignment_substitutions s
  join me on me.id = s.sub_instructor_id
  join program_assignments pa on pa.id = s.parent_assignment_id and s.parent_assignment_type='program'
  join programs pr on pr.id = pa.program_id
  left join program_locations pl on pl.id = pr.program_location_id
  where s.status in ('pending','confirmed','taught') and pa.published_at is not null;
$function$;
revoke all on function public.get_my_sub_details() from public, anon;
grant execute on function public.get_my_sub_details() to authenticated;

-- ── Roster helper: session ids a sub may still see the roster for ─────────────
-- Confirmed/taught, and only through 2 days after the sub's day (then the kids'
-- medical/emergency PII goes dark). SECURITY DEFINER so it resolves the
-- polymorphic parent without the sub needing to read camp_assignments.
create or replace function public.sub_roster_session_ids()
  returns setof uuid language sql stable security definer set search_path to 'public'
as $function$
  select ca.camp_session_id
  from assignment_substitutions s
  join instructors i on i.id = s.sub_instructor_id
  join camp_assignments ca on ca.id = s.parent_assignment_id and s.parent_assignment_type='camp'
  where i.auth_user_id = auth.uid() and s.status in ('confirmed','taught')
    and current_date <= s.date + 2 and ca.published_at is not null;
$function$;
revoke all on function public.sub_roster_session_ids() from public, anon;
grant execute on function public.sub_roster_session_ids() to authenticated;

-- Roster sub-policies use the helper (replaces the 20260529 camp_assignments-join
-- versions; adds the expiry, and no longer depends on the sub reading the parent).
drop policy if exists subs_read_camp_rosters on public.registrations;
create policy subs_read_camp_rosters on public.registrations for select to authenticated
  using (camp_session_id is not null and camp_session_id in (select public.sub_roster_session_ids()));

drop policy if exists subs_read_camp_roster_students on public.students;
create policy subs_read_camp_roster_students on public.students for select to authenticated
  using (id in (select r.student_id from public.registrations r
    where r.student_id is not null and r.camp_session_id in (select public.sub_roster_session_ids())));

drop policy if exists subs_read_camp_roster_parents on public.parents;
create policy subs_read_camp_roster_parents on public.parents for select to authenticated
  using (id in (select r.parent_id from public.registrations r
    where r.parent_id is not null and r.camp_session_id in (select public.sub_roster_session_ids())));

-- Belt-and-suspenders: no broad parent-read policy should exist (subs use the
-- resolver above, not a raw row read).
drop policy if exists instructor_sub_read_camp_assignments on public.camp_assignments;
drop policy if exists instructor_sub_read_program_assignments on public.program_assignments;
