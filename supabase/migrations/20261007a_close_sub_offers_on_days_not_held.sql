-- Close open sub offers for class-days that are no longer being held.
--
-- WHY. Westridge closed on 2026-09-29 (program_locations.closure_dates), so
-- derive_program_session_dates dropped that Tuesday and pushed the class out a
-- week. The three sub offers already sent for 9/29 stayed 'pending'. Nothing
-- re-checks an offer against the schedule, so on 10/7 Ricky still had a live
-- Accept/Decline card for a class that never ran, and so did the other two.
-- sub-offer-nudges-cron would have chased the same people about it had the day
-- fallen inside its window.
--
-- WHY A SWEEP, NOT A TRIGGER. A class-day disappears through several writers:
-- a site closure, a district calendar, the closure-scope choice, an edit to the
-- program's first date or count, the program being cancelled. A trigger on one
-- of them would cover one of them. The schedule itself is the single source of
-- truth (derive_program_session_dates), so this asks IT, once a day, for every
-- open offer.
--
-- WHEN. Daily at 16:45 UTC, before sub-offer-nudges-daily (17:00 UTC), so a
-- day closed by the previous evening is never chased. A day closed during the
-- day is closed by the next morning's run.
--
-- WHAT IT WRITES. The same shape cancel-sub-cover writes for a withdrawn offer
-- whose day needs nobody: status 'cancelled', cover_still_needed false, which
-- the admin modal labels "Cancelled, no sub needed", the portal stops showing,
-- get_sub_coverage drops, and accept_sub_offer refuses ('already_responded').
-- No email: these people never accepted anything, and nothing has been
-- promised to them.
--
-- FAILS TOWARD LEAVING THE OFFER ALONE. Cancelling a live offer for a class
-- that IS running takes a sub away from a room, which is worse than a stale
-- card. So a program whose schedule comes back NULL or empty (no first date, no
-- count) is treated as "do not know", never as "no days". Only PENDING rows are
-- touched; a confirmed cover on a closed day is a real person who said yes and
-- is left for the operator. Camp-type parents (the SU26 camp_assignments model)
-- are not swept: derive_program_session_dates does not describe them.
-- Past dates are not swept either: the portal hides an unanswered offer once
-- its day has gone, and "no sub needed" would not be true of a day that ran.

create or replace function public.close_sub_offers_on_days_not_held()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_closed integer;
begin
  with live as (
    select s.id,
           pa.program_id,
           s.date,
           coalesce(p.status, 'open') = 'cancelled' as program_cancelled
      from assignment_substitutions s
      join program_assignments pa on pa.id = s.parent_assignment_id
      join programs p on p.id = pa.program_id
     where s.parent_assignment_type = 'program'
       and s.status = 'pending'
       and s.date >= current_date
  ),
  -- NOT derive_program_session_dates_bulk: that one filters on is_org_member(),
  -- which is false for pg_cron (no auth.uid()), so it returns no rows and this
  -- sweep would close nothing, silently, forever.
  schedule as (
    select x.program_id, derive_program_session_dates(x.program_id) as session_dates
      from (select distinct program_id from live) x
  ),
  not_held as (
    select l.id
      from live l
      left join schedule sc on sc.program_id = l.program_id
     where l.program_cancelled
        or (coalesce(array_length(sc.session_dates, 1), 0) > 0
            and not (l.date = any (sc.session_dates)))
  )
  update assignment_substitutions s
     set status             = 'cancelled',
         cover_still_needed = false,
         cancelled_at       = now(),
         cancel_reason      = 'Class not held on this day',
         updated_at         = now()
    from not_held n
   where s.id = n.id
     and s.status = 'pending';

  get diagnostics v_closed = row_count;
  return v_closed;
end;
$$;

comment on function public.close_sub_offers_on_days_not_held() is
  'Nightly (pg_cron sub-offers-days-not-held, 16:45 UTC, before sub-offer-nudges-daily). '
  'Cancels PENDING program sub offers dated today or later whose day is no longer in '
  'derive_program_session_dates, or whose program is cancelled. Unknown schedule = left alone.';

-- Cron/service only. REVOKE FROM PUBLIC does not remove anon or authenticated,
-- which Supabase grants explicitly, so all three are named.
revoke all on function public.close_sub_offers_on_days_not_held() from public, anon, authenticated;
grant execute on function public.close_sub_offers_on_days_not_held() to service_role;

-- Schedule (idempotent: unschedule any earlier copy first).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'sub-offers-days-not-held') then
    perform cron.unschedule('sub-offers-days-not-held');
  end if;
  perform cron.schedule('sub-offers-days-not-held', '45 16 * * *',
    $job$ select public.close_sub_offers_on_days_not_held() $job$);
end;
$$;
