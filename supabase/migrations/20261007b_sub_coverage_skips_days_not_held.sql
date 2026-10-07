-- The sub-coverage board stops alarming about class-days that are not held.
--
-- WHY. 20261007a closes PENDING offers for a day that left the schedule (a site
-- closure, a district calendar day, a program edit). But get_sub_coverage never
-- asks the schedule either, so a closed day that had a DECLINE on it still read
-- 'uncovered' on the board (decline_count > 0) until the date passed - telling
-- the operator to find a sub for a class that is not running.
--
-- ONE SPELLING. "Does this program meet on this date" now lives in one function,
-- program_meets_on, used by the board AND the nightly sweep. Unknown schedule
-- (no first date / no count, so derive returns nothing) answers TRUE: both
-- callers must fail toward "it might be running" - the board keeps alarming and
-- the sweep keeps the offer - because hiding a real uncovered class is worse
-- than one stale row.
--
-- Camp-type parents (the SU26 camp_assignments model) are untouched: derive
-- does not describe them. A CONFIRMED cover on a day that is not held drops off
-- the board too (it already did: a settled day is never a coverage problem);
-- telling that sub is the job of the operator's cancel-a-session flow, not of a
-- nightly job.

-- ----------------------------------------------------- the one predicate --
create or replace function public.program_meets_on(p_program_id uuid, p_date date)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case
           when coalesce(array_length(x.d, 1), 0) = 0 then true
           else p_date = any (x.d)
         end
    from (select derive_program_session_dates(p_program_id) as d) x;
$$;

comment on function public.program_meets_on(uuid, date) is
  'True when the program meets on that date per derive_program_session_dates. '
  'Unknown schedule (derive returns nothing) = TRUE, so callers fail toward "it might be running".';

-- derive_program_session_dates is already executable by anon and returns the
-- same dates; this exposes nothing new, but nothing anonymous needs it.
revoke all on function public.program_meets_on(uuid, date) from public, anon;
grant execute on function public.program_meets_on(uuid, date) to authenticated, service_role;

-- --------------------------------------------------- the board, filtered --
-- Unchanged from 20260923h except ONE line in the program branch of
-- offer_rows: `and program_meets_on(p.id, a.date)`. lead_out_rows already walks
-- the derived dates, so it never had this gap.
create or replace function public.get_sub_coverage(p_org uuid)
returns table(
  parent_assignment_id uuid,
  parent_assignment_type text,
  slot_date date,
  state text,
  decliner_name text,
  curriculum_label text,
  location_label text,
  offers_out integer,
  decline_count integer,
  lead_out_name text
)
language sql
stable
set search_path to 'public'
as $function$
  with offer_rows as (
    select
      a.parent_assignment_id                as parent_assignment_id,
      'camp'::text                          as parent_assignment_type,
      a.date                                as slot_date,
      a.status                              as status,
      a.sub_instructor_id                   as sub_instructor_id,
      a.decline_reason                      as decline_reason,
      a.email_sent_at                       as email_sent_at,
      a.cover_still_needed                  as cover_still_needed,
      cs.curriculum_name                    as curriculum_label,
      cs.location_name                      as location_label,
      nullif(trim(coalesce(nullif(i.preferred_name, ''), i.first_name, '')
                  || ' ' || coalesce(i.last_name, '')), '') as instructor_name
    from assignment_substitutions a
    join camp_assignments ca
      on ca.id = a.parent_assignment_id
     and ca.organization_id = p_org
     and ca.status <> 'withdrawn'
    join camp_sessions cs
      on cs.id = ca.camp_session_id
     and cs.organization_id = p_org
     and cs.status = 'active'
    left join instructors i on i.id = a.sub_instructor_id
    where a.organization_id = p_org
      and a.parent_assignment_type = 'camp'
      and a.date >= current_date

    union all

    select
      a.parent_assignment_id,
      'program'::text,
      a.date,
      a.status,
      a.sub_instructor_id,
      a.decline_reason,
      a.email_sent_at,
      a.cover_still_needed,
      p.curriculum,
      pl.name,
      nullif(trim(coalesce(nullif(i.preferred_name, ''), i.first_name, '')
                  || ' ' || coalesce(i.last_name, '')), '')
    from assignment_substitutions a
    join program_assignments pa
      on pa.id = a.parent_assignment_id
     and pa.organization_id = p_org
     and pa.status not in ('withdrawn', 'cancelled')
    join programs p
      on p.id = pa.program_id
     and p.organization_id = p_org
     and coalesce(p.status, 'open') <> 'cancelled'
    left join program_locations pl on pl.id = p.program_location_id
    left join instructors i on i.id = a.sub_instructor_id
    where a.organization_id = p_org
      and a.parent_assignment_type = 'program'
      and a.date >= current_date
      and program_meets_on(p.id, a.date)
  ),
  slots as (
    select
      r.parent_assignment_id,
      r.parent_assignment_type,
      r.slot_date,
      max(r.curriculum_label) as curriculum_label,
      max(r.location_label)   as location_label,
      count(distinct r.sub_instructor_id) filter (
        where r.status = 'pending' and r.email_sent_at is not null
      )::int as offers_out,
      -- A release that still wants somebody. One released because the class no
      -- longer needs a sub is deliberately NOT counted: that day is settled.
      count(*) filter (
        where r.status = 'cancelled' and r.cover_still_needed is not false
      )::int as cancelled_count,
      count(*) filter (where r.status = 'cancelled')::int as any_cancelled,
      count(distinct r.sub_instructor_id) filter (
        where r.status = 'declined' and r.decline_reason is distinct from 'covered_by_other'
      )::int as decline_count,
      case when count(distinct r.sub_instructor_id) filter (
             where r.status = 'declined' and r.decline_reason is distinct from 'covered_by_other'
           ) = 1
           then max(r.instructor_name) filter (
             where r.status = 'declined' and r.decline_reason is distinct from 'covered_by_other'
           )
      end as decliner_name
    from offer_rows r
    group by r.parent_assignment_id, r.parent_assignment_type, r.slot_date
    having count(*) filter (where r.status in ('confirmed', 'taught')) = 0
       and count(*) filter (where r.status in ('pending', 'declined', 'cancelled')) > 0
  ),
  live_program_assignments as (
    select pa.id as assignment_id, pa.instructor_id, p.id as program_id,
           p.curriculum, pl.name as location_label
    from program_assignments pa
    join programs p
      on p.id = pa.program_id
     and p.organization_id = p_org
     and coalesce(p.status, 'open') <> 'cancelled'
    left join program_locations pl on pl.id = p.program_location_id
    where pa.organization_id = p_org
      and pa.status not in ('withdrawn', 'cancelled', 'declined')
      and pa.instructor_id is not null
  ),
  program_dates as (
    select b.program_id, b.session_dates
    from derive_program_session_dates_bulk(
           array(select distinct program_id from live_program_assignments)
         ) b
  ),
  lead_out_rows as (
    select
      la.assignment_id                        as parent_assignment_id,
      'program'::text                         as parent_assignment_type,
      d::date                                 as slot_date,
      la.curriculum                           as curriculum_label,
      la.location_label                       as location_label,
      nullif(trim(coalesce(nullif(i.preferred_name, ''), i.first_name, '')
                  || ' ' || coalesce(i.last_name, '')), '') as lead_out_name
    from live_program_assignments la
    join program_dates pd on pd.program_id = la.program_id
    join instructors i on i.id = la.instructor_id
    cross join lateral unnest(pd.session_dates) as d
    where d::date >= current_date
      and exists (
        select 1
        from instructor_term_availability ta
        where ta.instructor_id = la.instructor_id
          and d::date = any (ta.unavailable_dates)
      )
      and not exists (
        select 1
        from assignment_substitutions s
        where s.parent_assignment_id = la.assignment_id
          and s.parent_assignment_type = 'program'
          and s.date = d::date
      )
  )
  select
    s.parent_assignment_id,
    s.parent_assignment_type,
    s.slot_date,
    case
      when s.decline_count > 0   and s.offers_out > 0 then 'at_risk'
      when s.decline_count > 0                        then 'uncovered'
      when s.cancelled_count > 0 and s.offers_out > 0 then 'at_risk'
      when s.cancelled_count > 0                      then 'uncovered'
      when s.offers_out = 0                           then 'uncovered'
      else                                                 'awaiting'
    end as state,
    case when s.decline_count = 1 then s.decliner_name end as decliner_name,
    s.curriculum_label,
    s.location_label,
    s.offers_out,
    s.decline_count,
    null::text as lead_out_name
  from slots s
  -- A day whose ONLY rows are releases that no longer need anybody is settled,
  -- not silent: nobody is coming because nobody is needed.
  where not (s.any_cancelled > 0 and s.cancelled_count = 0
             and s.decline_count = 0 and s.offers_out = 0)

  union all

  select
    lo.parent_assignment_id,
    lo.parent_assignment_type,
    lo.slot_date,
    'lead_out'::text as state,
    null::text       as decliner_name,
    lo.curriculum_label,
    lo.location_label,
    0                as offers_out,
    0                as decline_count,
    lo.lead_out_name
  from lead_out_rows lo;
$function$;

revoke execute on function public.get_sub_coverage(uuid) from public;
revoke execute on function public.get_sub_coverage(uuid) from anon;
grant execute on function public.get_sub_coverage(uuid) to authenticated, service_role;

-- ------------------------------------------- the sweep, same predicate --
-- Same behaviour as 20261007a; the inline "non-empty schedule and date not in
-- it" now reads program_meets_on, so the board and the sweep cannot disagree.
create or replace function public.close_sub_offers_on_days_not_held()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_closed integer;
begin
  update assignment_substitutions s
     set status             = 'cancelled',
         cover_still_needed = false,
         cancelled_at       = now(),
         cancel_reason      = 'Class not held on this day',
         updated_at         = now()
    from program_assignments pa
    join programs p on p.id = pa.program_id
   where pa.id = s.parent_assignment_id
     and s.parent_assignment_type = 'program'
     and s.status = 'pending'
     and s.date >= current_date
     and (coalesce(p.status, 'open') = 'cancelled'
          or not program_meets_on(p.id, s.date));

  get diagnostics v_closed = row_count;
  return v_closed;
end;
$$;
