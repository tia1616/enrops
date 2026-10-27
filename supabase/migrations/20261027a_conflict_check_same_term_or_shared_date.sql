-- An instructor is double-booked only when two classes provably meet on the
-- same date at overlapping times. Weekday + time is the fallback for when the
-- dates are not known yet.
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
-- The same weekday-only test was wrong INSIDE a term too, found on staging the
-- same day while proving the fix: every camp carries day_of_week = its first
-- day, so a Dec 21-23 winter break camp and a Feb 15-19 mid-winter break camp
-- are both "Monday 9-3" and the trigger refused one instructor for both. J2S
-- runs three break-camp weeks a year (winter, mid-winter, spring); anyone
-- staffing two of them in one term was refused.
--
-- THE RULE NOW:
--   1. The two must share a weekday (a camp occupies every day in class_days)
--      and overlap in time, with the untrusted-time fail-closed branch as before.
--   2. BOTH DATED: derive_program_session_dates() decides - a conflict only if
--      they share a session date. Same term or not. Closures are already in
--      those dates, so a class that skips break week does not clash with the
--      break camp, and one that still meets that week does.
--   3. NOT BOTH DATED, SAME TERM: the old rule, day_of_week + time. Staffing
--      happens before a term's dates are set, so this keeps the double-booking
--      guard the board has always relied on.
--   4. NOT BOTH DATED, DIFFERENT TERM: not a conflict (Jessica: "only compare
--      same-term classes"). The board and the matcher never loaded another
--      term anyway.
--
-- BEFORE / AFTER / LOST (this narrows a guard):
--   LOST: (a) cross-term pairs where either side is undated; (b) same-term dated
--   pairs on the same weekday+time that never meet on a date - two break camps,
--   or a short class and a late-starting one. Both are the fix.
--   GAINED: a dated camp is now checked on EVERY day it runs, not only the day
--   its day_of_week names - a Mon-Fri break camp against a Wednesday class that
--   still meets that week used to pass here.
--   KEPT: terms overlap at the edges (a WI27 class starting 2/2 for 8 weeks runs
--   into late March; SP27 starts 3/3) - a shared date still blocks across terms.
--
-- UPDATES THAT DO NOT MOVE THE ASSIGNMENT ARE NOT RE-CHECKED. The trigger fires
-- on every UPDATE, including reminder_sent_at, flagged_reason and pay writes. A
-- row is checked when it is created and whenever its instructor, class or
-- status changes; re-judging it because a reminder went out could only ever
-- fail a reminder or a payout, never protect anyone. It also keeps the date
-- walk off those hot paths.
--
-- derive_program_session_dates is SECURITY INVOKER and STABLE, as is this
-- trigger. If it cannot see or date a class it returns '{}', which falls to
-- rule 3 or 4 - the pre-existing behaviour, never a new block.
--
-- Carried over unchanged from 20260908a: the cancelled/archived exclusion and
-- the untrusted-time fail-closed branch. The KNOWN HOLE noted there (reopening a
-- cancelled class is not re-checked) still stands and is still Jessica's call.

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
  t_days       text[];
  t_dates      date[];
begin
  if new.status in ('withdrawn', 'declined') or new.instructor_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.instructor_id is not distinct from old.instructor_id
     and new.program_id    is not distinct from old.program_id
     and new.status        is not distinct from old.status then
    return new;
  end if;

  select p.day_of_week, p.class_days, p.start_time, p.end_time, p.program_location_id, p.curriculum, p.term
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

  -- Every weekday the class occupies: all of class_days for a camp, the one
  -- day_of_week for a weekly class.
  t_days := case
    when coalesce(cardinality(target.class_days), 0) > 0
      then (select array_agg(lower(btrim(x))) from unnest(target.class_days) x)
    else array[lower(btrim(target.day_of_week))]
  end;
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
      -- THE FIX. CASE, not AND/OR, so the order is guaranteed: the cheap
      -- weekday test runs first and the date walk only for what survives it.
      and case
        when not (t_days && case
                    when coalesce(cardinality(p2.class_days), 0) > 0
                      then (select array_agg(lower(btrim(x))) from unnest(p2.class_days) x)
                    else array[lower(btrim(p2.day_of_week))]
                  end)
          then false
        else (
          select case
            when cardinality(t_dates) > 0 and cardinality(d.dates) > 0
              then t_dates && d.dates                                   -- rule 2
            when p2.term is not distinct from target.term
              then lower(btrim(p2.day_of_week)) = lower(btrim(target.day_of_week)) -- rule 3
            else false                                                  -- rule 4
          end
          from (select coalesce(derive_program_session_dates(p2.id), '{}') as dates) d
        )
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
