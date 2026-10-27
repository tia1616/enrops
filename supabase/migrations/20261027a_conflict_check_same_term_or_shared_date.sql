-- A class in another term only blocks its instructor if the two actually meet
-- on the same date.
--
-- Found on PROD 2026-10-27, reported by Jessica as "why won't enrops match
-- instructors for me". Match remaining on Winter 2027 failed outright with
-- "Instructor conflict: already on Robotics Builders: Carnival Games &
-- Challenges at Beatrice Morrow Cannady at that time". That class is FALL 2026
-- (Mondays 2:05-3:05 PM, Upama, confirmed). The matcher put Upama on a Winter
-- Monday class at an overlapping time, the trigger compared weekday + time
-- only, and because the matcher inserts every proposed row in ONE statement,
-- one rejected row failed all 52.
--
-- The check never looked at term or dates, so every live fall class reserved
-- its instructor's weekday slot in EVERY later term, forever. On prod that was
-- 32 fall classes across 8 instructors at the time of the fix. Neither the
-- matcher nor the board could see it: both load ONE term's programs and
-- assignments, so they offered the assignment and the save refused it.
--
-- THE RULE NOW:
--   - SAME TERM: unchanged. Weekday + time overlap is a conflict, dates or no
--     dates. Staffing happens before a term's dates are set (most WI27 classes
--     had none on staging), so demanding a date match here would drop the
--     double-booking guard the board has always relied on.
--   - DIFFERENT TERM: a conflict only when derive_program_session_dates() for
--     both classes returns dates and they share at least one. This is the
--     same "provably meet" test the board's coincidence() uses for camps.
--
-- BEFORE / AFTER / LOST (this narrows a guard):
--   LOST: a cross-term pair where either side has no dates yet. Those no longer
--   block. That is deliberate and is what Jessica approved ("only compare
--   same-term classes"); it also matches what the board and the matcher have
--   always done, since neither ever loaded another term.
--   KEPT, beyond the bare same-term rule: terms DO overlap at the edges (a WI27
--   Tuesday class starting 2/2 for 8 weeks runs into late March; SP27 classes
--   start 3/3). A pure term filter would silently allow that real double
--   booking, which this trigger blocks today. The shared-date test keeps it.
--
-- derive_program_session_dates is SECURITY INVOKER and STABLE, as is this
-- trigger, so it reads with the same rights the trigger already reads programs
-- with. If it cannot see a row it returns '{}', and an empty array never
-- overlaps, so a cross-term pair it cannot date is allowed - the LOST case above,
-- not a new one. It is only called for rows already on the same weekday with an
-- overlapping (or unreadable) time, and in a different term.
--
-- Everything else is carried over unchanged from 20260908a, including the
-- cancelled/archived exclusion and the untrusted-time fail-closed branch. The
-- KNOWN HOLE noted there (reopening a cancelled class is not re-checked) still
-- stands and is still Jessica's call.

create or replace function public.check_program_assignment_conflict()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  target       record;
  conflict_row record;
  t_start      time;
  t_end        time;
  t_untrusted  boolean;
  t_dates      date[];
begin
  if new.status in ('withdrawn', 'declined') or new.instructor_id is null then
    return new;
  end if;

  select p.day_of_week, p.start_time, p.end_time, p.program_location_id, p.curriculum, p.term
    into target
    from programs p
    where p.id = new.program_id;

  if not found or target.day_of_week is null then
    return new;
  end if;

  t_start := parse_program_time(target.start_time);
  t_end   := parse_program_time(target.end_time);
  t_untrusted := coalesce(
       (target.start_time !~* '(am|pm)' and t_start < time '08:00')
    or (target.end_time   !~* '(am|pm)' and t_end   < time '08:00'),
    true);

  -- Only needed for the cross-term test below. '{}' when the class has no dates
  -- yet, which never overlaps anything.
  t_dates := coalesce(derive_program_session_dates(new.program_id), '{}');

  select pa.id, p2.curriculum, coalesce(pl.name, 'another school') as loc
    into conflict_row
    from program_assignments pa
    join programs p2 on p2.id = pa.program_id
    left join program_locations pl on pl.id = p2.program_location_id
    where pa.id <> new.id
      and pa.instructor_id = new.instructor_id
      and pa.status not in ('withdrawn', 'declined')
      -- A cancelled or archived class is not happening, so it cannot occupy
      -- anybody (20260908a).
      and coalesce(p2.status, '') not in ('cancelled', 'archived')
      and p2.id <> new.program_id
      and lower(btrim(p2.day_of_week)) = lower(btrim(target.day_of_week))
      and (
        t_start is null
        or t_end is null
        or t_untrusted
        or parse_program_time(p2.start_time) is null
        or parse_program_time(p2.end_time) is null
        or (p2.start_time !~* '(am|pm)' and parse_program_time(p2.start_time) < time '08:00')
        or (p2.end_time   !~* '(am|pm)' and parse_program_time(p2.end_time)   < time '08:00')
        or (
          t_start < parse_program_time(p2.end_time)
          and parse_program_time(p2.start_time) < t_end
        )
      )
      -- THE FIX. Same term: weekday + time is enough, as before. Another term:
      -- only if the two provably meet on a date. CASE, not OR, so the date walk
      -- runs only for cross-term rows.
      and case
        when p2.term is not distinct from target.term then true
        else coalesce(t_dates && derive_program_session_dates(p2.id), false)
      end
    limit 1;

  if found then
    raise exception
      'Instructor conflict: already on % at % at that time. Free that class first, or pick someone else.',
      conflict_row.curriculum,
      conflict_row.loc
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;
