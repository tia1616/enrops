-- A cancelled class must not block its instructor from taking another one.
--
-- Found on PROD 2026-09-08, reported by Jessica as "I click the name and nothing
-- happens". Marquix Adamson could not be assigned to Robotics Explorers
-- (Buckman, Tue 2:30-3:45 PM). The picker showed him as eligible with only a
-- harmless warning about a genuinely back-to-back class at the same school.
--
-- The real blocker was a DIFFERENT row: Pokemon Game Makers at Orenco,
-- Tue 2:25-3:25 PM, which does overlap - except that program is
-- status = 'cancelled'. Its assignment row is still status = 'confirmed',
-- because cancelling a class does not withdraw the assignment.
--
-- check_program_assignment_conflict filtered on the ASSIGNMENT status
-- (pa.status not in ('withdrawn','declined')) and never looked at the PROGRAM
-- status, so a class nobody is teaching kept reserving its instructor's
-- afternoon. This tenant cancels classes routinely to free up a finite kit pool,
-- so every cancellation was quietly shrinking who could be scheduled.
--
-- Two things made it hard to see, and both are worth fixing separately:
--   - the trigger's exception surfaces through performAssign's catch into a
--     banner on the BOARD, while the picker modal stays open on top of it, so
--     the operator sees no feedback at all;
--   - the picker's own warning listed the harmless back-to-back clash and never
--     mentioned the overlapping one, so the screen pointed at the wrong class.
--
-- 'archived' IS UNREACHABLE for a program and is matched defensively only.
-- programs_status_check allows exactly draft / open / closed / cancelled. Several
-- existing filters in this codebase list an archived program status; none of them
-- can ever match one, and I copied the list from those rather than reading the
-- constraint. In practice this clause frees instructors from CANCELLED classes.
-- (camp_sessions is a separate CHECK: active / cancelled.)
--
-- KNOWN HOLE, found by the code review of this very change and deliberately not
-- fixed here: this trigger fires only on program_assignments INSERT/UPDATE, never
-- on a change to programs.status. So cancel -> book that instructor elsewhere at
-- the same time -> REOPEN the class leaves two genuinely overlapping active
-- assignments, silently. Before this change that window could not open, because
-- cancelling did not free anybody. Closing it needs a matching trigger on
-- programs.status, but whether reopening should be BLOCKED or merely WARNED is a
-- product decision - blocking could strand an operator mid-reopen - so it is
-- Jessica's call, not a guess made here.
--
-- SUBTRACTION AUDIT. This narrows what counts as a conflict, so: can it now
-- allow a real double-booking? Only if an instructor is genuinely teaching a
-- class whose program is cancelled or archived, which is a contradiction -
-- those are exactly the states that mean "not happening". 'draft' is
-- deliberately NOT added: a draft is unscheduled rather than abandoned, and
-- treating it as free is a judgement call that belongs to a separate decision.
-- Everything else about the check is untouched, including the untrusted-time
-- fail-closed branch that treats an unparseable time as a conflict.

create or replace function public.check_program_assignment_conflict()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  target      record;
  conflict_row record;
  t_start     time;
  t_end       time;
  t_untrusted boolean;
begin
  if new.status in ('withdrawn', 'declined') or new.instructor_id is null then
    return new;
  end if;

  select p.day_of_week, p.start_time, p.end_time, p.program_location_id, p.curriculum
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

  select pa.id, p2.curriculum, coalesce(pl.name, 'another school') as loc
    into conflict_row
    from program_assignments pa
    join programs p2 on p2.id = pa.program_id
    left join program_locations pl on pl.id = p2.program_location_id
    where pa.id <> new.id
      and pa.instructor_id = new.instructor_id
      and pa.status not in ('withdrawn', 'declined')
      -- THE FIX. A cancelled or archived class is not happening, so it cannot
      -- occupy anybody. Cancelling a class does not withdraw its assignment
      -- rows, so without this the instructor stays booked for a class that no
      -- longer runs.
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
