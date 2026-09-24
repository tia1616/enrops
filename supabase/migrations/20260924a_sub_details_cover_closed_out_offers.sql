-- A closed-out offer needs to be able to NAME the class it was about.
--
-- The instructor portal now shows a sub whose offer was closed because somebody
-- else accepted first - until this they simply vanished from the screen with no
-- sentence anywhere. But the card's class name, venue and time all come from
-- get_my_sub_details, whose status filter admits only pending|confirmed|taught.
-- A declined row therefore gets NO details back, and every one of those cards
-- would have fallen through to "that class" with an empty venue: a grey box
-- telling an instructor with three schools that something, somewhere, on a date,
-- was covered.
--
-- Found by an independent reviewer before it shipped. It could not have been
-- caught by looking at the screen either, because there is not one
-- covered_by_other row on staging to render.
--
-- SAFE TO WIDEN. Both legs self-join `me on me.id = s.sub_instructor_id`, so
-- this function only ever returns the CALLER'S OWN substitutions; adding a
-- status admits more of their own rows and nobody else's. published_at is still
-- required on the parent, so an unpublished class stays invisible. The only
-- caller is InstructorPortal's loadSubAssignments, which maps these details
-- onto rows it has already read under RLS - so this fills in blanks, it does
-- not surface anything new.
--
-- 'cancelled' is deliberately NOT added: nothing renders a cancelled row to an
-- instructor, and a status that no screen reads is a row nobody asked for.
--
-- CREATE OR REPLACE with an unchanged signature, so the grants survive and this
-- is not a DROP - a dropped-and-recreated public function is born with an anon
-- EXECUTE grant that REVOKE ... FROM public does not remove.

create or replace function public.get_my_sub_details()
returns table(
  substitution_id uuid,
  parent_assignment_type text,
  parent_assignment_id uuid,
  covered_instructor_id uuid,
  session jsonb,
  location jsonb
)
language sql
stable
security definer
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
  where s.status in ('pending','confirmed','taught','declined') and ca.published_at is not null
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
  where s.status in ('pending','confirmed','taught','declined') and pa.published_at is not null;
$function$;

revoke execute on function public.get_my_sub_details() from public;
revoke execute on function public.get_my_sub_details() from anon;
