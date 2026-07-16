-- Double-booking: enforce it in the DB, not just the picker.
--
-- camp_assignments has had check_camp_assignment_conflict (BEFORE INSERT OR UPDATE)
-- for a long time; program_assignments had NO triggers at all, so after-school
-- double-booking was UI-only. That's the "invariant in the UI or the DB but not
-- both" bug class: anything that isn't the picker (an edge fn, a backfill, a future
-- screen) could quietly create a conflict the operator was told is impossible.
--
-- The rule mirrors check_camp_assignment_conflict, translated to after-school's
-- weekday+time shape, and matches AfterschoolSchedule.jsx's evaluate() exactly so the
-- two can't disagree:
--   same instructor, same weekday, different program, and EITHER
--     - a different location (can't be at two schools the same afternoon), OR
--     - the class times actually overlap (physically impossible)
--   Two back-to-back classes at the SAME school stay legal - that's a real schedule.
--
-- Statuses: skip withdrawn/declined (dead rows) and unassigned rows. Everything else
-- counts, INCLUDING 'proposed' - camp filters only 'withdrawn', and a matcher draft
-- still occupies the person.

-- Programs store start/end as 12-hour TEXT ("2:35 PM"); camps use a real `time`.
-- Parse both, and return NULL rather than raising on anything unrecognised: an
-- unparseable time must never take down a legitimate write. NULL simply means "can't
-- compare times", and the caller then relies on the location test alone.
create or replace function public.parse_program_time(t text)
returns time
language plpgsql
immutable
set search_path to 'public', 'pg_temp'
as $function$
begin
  if t is null or btrim(t) = '' then
    return null;
  end if;
  begin
    return to_timestamp(btrim(t), 'HH12:MI AM')::time;  -- "2:35 PM"
  exception when others then
    null;
  end;
  begin
    return btrim(t)::time;                               -- "14:35" / "14:35:00"
  exception when others then
    return null;
  end;
end;
$function$;

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

  select pa.id, p2.curriculum, coalesce(pl.name, 'another school') as loc
    into conflict_row
    from program_assignments pa
    join programs p2 on p2.id = pa.program_id
    left join program_locations pl on pl.id = p2.program_location_id
    where pa.id <> new.id
      and pa.instructor_id = new.instructor_id
      and pa.status not in ('withdrawn', 'declined')
      and p2.id <> new.program_id
      and lower(btrim(p2.day_of_week)) = lower(btrim(target.day_of_week))
      and (
        -- Different school on the same afternoon: impossible travel.
        p2.program_location_id is distinct from target.program_location_id
        -- Or the same school with genuinely overlapping times.
        or (
          t_start is not null and t_end is not null
          and parse_program_time(p2.start_time) is not null
          and parse_program_time(p2.end_time) is not null
          and t_start < parse_program_time(p2.end_time)
          and parse_program_time(p2.start_time) < t_end
        )
      )
    limit 1;

  if found then
    raise exception
      'Instructor conflict: already on % at % that day. Free that class first, or pick someone else.',
      conflict_row.curriculum,
      conflict_row.loc
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;

drop trigger if exists program_assignment_conflict_check on public.program_assignments;
create trigger program_assignment_conflict_check
  before insert or update on public.program_assignments
  for each row execute function check_program_assignment_conflict();
