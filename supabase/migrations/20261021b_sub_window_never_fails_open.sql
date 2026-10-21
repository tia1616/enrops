-- Review round on 20261021a: two ways the date-aware sub check could let a
-- double-booked sub through where the old date-blind check did not. Both fail
-- OPEN (a refusal that should happen does not), so both are closed here.
--
-- F1. AN EARLY-RELEASE DAY WITH NO END TIME. The editors allow an early-release
--     start with a blank end (EarlyReleaseChoice saves end: ""), and the
--     schedule then returns session_end_time NULL. The slot's end became NULL,
--     and accept_sub_offer skips the whole conflict test when either end of a
--     window is unknown - so a sub with another class at that hour was let
--     through. Before 20261021a the slot used programs.end_time, so the test
--     ran. The slot now keeps the class's usual LENGTH: early-release start +
--     (usual end - usual start). program_session_times_on still returns NULL
--     there, because it is also what the sub is SHOWN, and an invented end time
--     on a card is worse than "Class starts 11:55" (earlyReleaseLine).
--     Prod on 2026-10-21: 2 classes opted in to early release, 0 with no end.
--
-- F2. A CLASS WHOSE SCHEDULE CANNOT BE DERIVED. derive_program_session_schedule
--     returns nothing when session_count is 0 (the column is NOT NULL, but 0 is
--     allowed) or first_session_date is missing, so
--     "the schedule says it meets" was false for every date and the class
--     stopped being a commitment at all. The old test fell back to
--     coalesce(session_count, sessions, 1). Now: if the schedule is EMPTY (it
--     does not know), use the old weekday + date-range test, so an unknown
--     schedule reads as busy rather than free. A schedule that does know - and
--     says no_school - still frees the person. Prod: 0 such classes.

create or replace function public.sub_slot_window(
  p_parent_type text, p_parent_assignment_id uuid, p_date date
)
returns table(ts time, te time)
language sql
stable
set search_path to 'public'
as $function$
  select cs.start_time, cs.end_time
    from camp_assignments ca
    join camp_sessions cs on cs.id = ca.camp_session_id
   where p_parent_type = 'camp' and ca.id = p_parent_assignment_id
  union all
  -- Same parse as before (12-hour text only, NULL otherwise). A day with a
  -- start but no end keeps the class's usual length (F1).
  select d.ts,
         coalesce(d.te,
                  case when d.ts is not null and u.us is not null and u.ue is not null and u.ue > u.us
                       then d.ts + (u.ue - u.us) end)
    from program_assignments pa
    join programs pr on pr.id = pa.program_id
    cross join lateral program_session_times_on(pa.program_id, p_date) t
    cross join lateral (
      select case when t.start_time ~* '^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$'
                  then to_timestamp(t.start_time, 'HH12:MI AM')::time end as ts,
             case when t.end_time ~* '^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$'
                  then to_timestamp(t.end_time, 'HH12:MI AM')::time end as te
    ) d
    cross join lateral (
      select case when pr.start_time ~* '^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$'
                  then to_timestamp(pr.start_time, 'HH12:MI AM')::time end as us,
             case when pr.end_time ~* '^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$'
                  then to_timestamp(pr.end_time, 'HH12:MI AM')::time end as ue
    ) u
   where p_parent_type = 'program' and pa.id = p_parent_assignment_id;
$function$;

revoke execute on function public.sub_slot_window(text, uuid, date) from public;
revoke execute on function public.sub_slot_window(text, uuid, date) from anon;
grant  execute on function public.sub_slot_window(text, uuid, date) to authenticated;
grant  execute on function public.sub_slot_window(text, uuid, date) to service_role;

create or replace function public.instructor_commitments_on_date(
  p_instructor uuid, p_date date
)
returns table(source text, ref_id uuid, ts time, te time)
language sql
stable
set search_path to 'public'
as $function$
  with wk as (
    select (array['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])
             [extract(dow from p_date)::int + 1] as lname
  )
  -- Their own after-school class, if the SCHEDULE says it meets that day and
  -- nobody is covering it. A no-school day is not a commitment.
  select 'teaching'::text, pa.id, w.ts, w.te
    from program_assignments pa
    join programs pr on pr.id = pa.program_id
    cross join lateral sub_slot_window('program', pa.id, p_date) w
   where pa.instructor_id = p_instructor
     and coalesce(pa.status, '') <> 'declined'
     and coalesce(pr.status, '') not in ('cancelled', 'draft')
     and p_date >= pr.first_session_date
     -- Cheap pre-filter only, so the schedule is walked for few programs. It is
     -- exactly the walk's own cadence: a weekly class steps 7 days from
     -- first_session_date; a class_days program is left to the schedule.
     and (coalesce(array_length(pr.class_days, 1), 0) > 0
          or extract(dow from p_date) = extract(dow from pr.first_session_date))
     and (
       exists (
         select 1 from derive_program_session_schedule(pr.id) x
          where x.entry_date = p_date and x.kind = 'session')
       -- F2: the schedule cannot be derived (no session count), so it knows
       -- nothing. Fall back to the old weekday + range test: busy, not free.
       or (
         not exists (select 1 from derive_program_session_schedule(pr.id))
         and lower(btrim(pr.day_of_week)) = (select lname from wk)
         and p_date <= coalesce(
               pr.end_date,
               pr.first_session_date
                 + ((greatest(coalesce(pr.session_count, pr.sessions, 1), 1) - 1) * 7))
       )
     )
     and not exists (
       select 1 from assignment_substitutions s
        where s.parent_assignment_id = pa.id
          and s.parent_assignment_type = 'program'
          and s.date = p_date
          and s.status in ('confirmed', 'taught'))

  union all

  select 'camp', ca.id, w.ts, w.te
    from camp_assignments ca
    join camp_sessions cs on cs.id = ca.camp_session_id
    cross join lateral sub_slot_window('camp', ca.id, p_date) w
   where ca.instructor_id = p_instructor
     and coalesce(ca.status, '') <> 'declined'
     and p_date >= cs.starts_on
     and p_date <= cs.ends_on
     and (cs.class_days is null or (select lname from wk) = any(cs.class_days))
     and not exists (
       select 1 from assignment_substitutions s
        where s.parent_assignment_id = ca.id
          and s.parent_assignment_type = 'camp'
          and s.date = p_date
          and s.status in ('confirmed', 'taught'))

  union all

  -- A day they are already covering for somebody else. Only settled rows: a
  -- live OFFER must not make somebody look busy, or asking two people about the
  -- same afternoon would take them both out of the running.
  select 'subbing', s.parent_assignment_id, w.ts, w.te
    from assignment_substitutions s
    cross join lateral sub_slot_window(s.parent_assignment_type, s.parent_assignment_id, s.date) w
   where s.sub_instructor_id = p_instructor
     and s.date = p_date
     and s.status in ('confirmed', 'taught');
$function$;

revoke execute on function public.instructor_commitments_on_date(uuid, date) from public;
revoke execute on function public.instructor_commitments_on_date(uuid, date) from anon;
grant  execute on function public.instructor_commitments_on_date(uuid, date) to authenticated;
grant  execute on function public.instructor_commitments_on_date(uuid, date) to service_role;
