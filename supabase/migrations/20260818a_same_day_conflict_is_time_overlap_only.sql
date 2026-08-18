-- Same-day classes at DIFFERENT schools are only a conflict when the times
-- actually OVERLAP.
--
-- The old rule blocked any two same-weekday classes at different locations,
-- whatever the gap. That is right for 2:05 and 2:35 and wrong for 12:15 and
-- 3:25. Verified against prod data 2026-08-18: J2S runs
--   LEGO Architects, Grass Valley, Wed 12:15-1:15 PM
--   LEGO Architects, OES,          Wed 3:25-4:25 PM
-- two hours ten minutes apart, and the board refused to staff one instructor on
-- both. Jessica hit this while scheduling and reported it as a bug.
--
-- What still blocks (Jessica, 2026-08-18, and 2026-07-16 before it):
--   * a real time overlap -- one person, two places, same clock. HARD BLOCK.
--   * times we cannot TRUST on EITHER side -- we cannot prove they don't
--     overlap, so fail closed rather than guess. This matches the frontend's
--     existing "can't see the other class -> fail closed" stance.
--
-- "Cannot trust" is wider than "cannot parse", and that matters here.
-- parse_program_time() calls to_timestamp(t, 'HH12:MI AM'), and Postgres
-- defaults to AM when the input carries no meridiem -- so '2:30' silently
-- becomes 02:30, a 2:30 PM class read as 2:30 in the morning. The OLD rule was
-- immune to that: a different location blocked regardless of the clock. This one
-- is not, so bad time data would become a FAIL-OPEN hole -- a genuine
-- double-booking waved through.
--
-- Measured 2026-08-18 before writing this: PROD has 0 of 116 programs missing a
-- meridiem and 0 parsing before 7am, so there is no live exposure. STAGING has 6
-- of 124. The risk is a NEW tenant typing '2:30' into a fresh org, which is
-- exactly the case this platform has to be built for. So a time with no
-- meridiem that lands in the small hours is treated as UNKNOWN, not as 2am.
-- That only ever makes this trigger more conservative; it cannot block a pair
-- that prod actually runs today.
--
-- What no longer blocks: a non-overlapping same-day class at another school.
-- The frontend warns when the gap is under an hour (Jessica's number: "with
-- commuting, might not be possible unless they're close together") but does not
-- stop the operator -- she knows the drive, the software does not.
--
-- Deploy order: THIS MIGRATION FIRST, frontend second. Relaxing the trigger
-- alone permits more than the UI offers, which changes nothing a user can see.
-- Shipping the frontend first would have the board offer an assignment that the
-- insert then rejects with check_violation.
--
-- Camp's twin (check_camp_assignment_conflict) is deliberately NOT touched here:
-- it compares morning/afternoon session_type buckets, not clock times, so there
-- is no gap to measure. Handled separately if at all.

CREATE OR REPLACE FUNCTION public.check_program_assignment_conflict()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- A meridiem-less time that lands in the small hours is almost certainly a PM
  -- time read as AM. Don't guess which -- call it unknown and fail closed.
  -- coalesce to TRUE: a null here means a null raw time, which is also unknown.
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
      and p2.id <> new.program_id
      and lower(btrim(p2.day_of_week)) = lower(btrim(target.day_of_week))
      -- Overlap, or untrusted times on either side (fail closed). A different
      -- location on its own is no longer a conflict.
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
