-- A sub covering an after-school class could not see the class's room.
-- get_my_sub_details is the SECURITY DEFINER whitelist the sub portal reads, and
-- its program branch omitted programs.room, so the sub saw only the SITE room -
-- which at Happy Valley Library is the summer camp room, not the after-school one.
-- A sub has most likely never been in the room, so they are the last person who
-- should get the wrong door. Additive: one more key in an existing jsonb, no
-- signature change, and a frontend that does not read it is unaffected.
--
-- ACL note: created with CREATE OR REPLACE so the existing grants are preserved
-- (authenticated + service_role, NOT anon). Read proacl back after applying.
create or replace function public.get_my_sub_details()
 returns table(substitution_id uuid, parent_assignment_type text, parent_assignment_id uuid, covered_instructor_id uuid, session jsonb, location jsonb)
 language sql
 stable security definer
 set search_path to 'public'
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
      'start_time',pr.start_time,'end_time',pr.end_time,'session_count',pr.session_count,'program_location_id',pr.program_location_id,
      'room',pr.room),
    case when pl.id is not null then jsonb_build_object('name',pl.name,'address',pl.address,'contact_phone',pl.contact_phone,
      'room_number',pl.room_number,'arrival_instructions',pl.arrival_instructions,'dismissal_instructions',pl.dismissal_instructions) else null end
  from assignment_substitutions s
  join me on me.id = s.sub_instructor_id
  join program_assignments pa on pa.id = s.parent_assignment_id and s.parent_assignment_type='program'
  join programs pr on pr.id = pa.program_id
  left join program_locations pl on pl.id = pr.program_location_id
  where s.status in ('pending','confirmed','taught') and pa.published_at is not null;
$function$;
