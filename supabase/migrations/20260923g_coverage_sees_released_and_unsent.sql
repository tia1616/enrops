-- The coverage alarm learns two states it was blind to. Ships WITH 20260923f,
-- which adds the 'cancelled' status this reads: a released cover under the old
-- function is a day that reports nothing at all.
--
-- A. A RELEASED DAY IS AN UNCOVERED DAY. The HAVING clause admitted a class-day
--    only when it held a pending or declined row, so a day whose sub had been
--    released - status 'cancelled', nobody else asked - was not returned at
--    all. No card, no banner, no homescreen count. The regular instructor is
--    out, nobody is coming, and the product says nothing.
--
-- B. A ROW IS NOT AN ASK. offers_out counted pending rows, but
--    create-assignment-substitution writes the row BEFORE it sends the email
--    and leaves it behind when Resend fails. One failed send therefore produced
--    offers_out = 1, decline_count = 0 and state 'awaiting' - the calm state -
--    for a person who had never heard of the day. Counting only offers whose
--    email actually left makes the number mean what the sentence built on it
--    says: "N people asked".
--
--    The consequence worth stating plainly: a class-day holding nothing but
--    rows that were never emailed now reports 'uncovered', because nobody has
--    in fact been asked. That is the honest reading and it is the direction
--    that fails safe.
--
-- The return columns are UNCHANGED on purpose, so this is a true CREATE OR
-- REPLACE. Adding a column would force a DROP, and a dropped-and-recreated
-- public function is born with an EXECUTE grant to anon that REVOKE ... FROM
-- public does not remove (the 2026-08-20 parent-email leak). The new states are
-- carried in `state`, which already exists.
--
-- src/lib/subCoverage.js is the client half of this same rule and changes in
-- the same pass. The boards hold their rows already and the banner asks the
-- database, so the two cannot be one query - they can only be kept identical.

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
  ),
  slots as (
    select
      r.parent_assignment_id,
      r.parent_assignment_type,
      r.slot_date,
      max(r.curriculum_label) as curriculum_label,
      max(r.location_label)   as location_label,
      -- (B) An offer counts once the email has left, not once the row exists.
      count(distinct r.sub_instructor_id) filter (
        where r.status = 'pending' and r.email_sent_at is not null
      )::int as offers_out,
      -- (A) A released cover, so a day that lost its sub is not silent.
      count(*) filter (where r.status = 'cancelled')::int as cancelled_count,
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
      -- Any substitution row at all means this day has been handled, so it is
      -- the slots branch above that speaks for it. A cancelled row now reaches
      -- that branch, which is what stops a released day falling between the two.
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
      -- Somebody refused and somebody else is still deciding.
      when s.decline_count > 0   and s.offers_out > 0 then 'at_risk'
      when s.decline_count > 0                        then 'uncovered'
      -- A cover was released. Asking again is under way, or it is not.
      when s.cancelled_count > 0 and s.offers_out > 0 then 'at_risk'
      when s.cancelled_count > 0                      then 'uncovered'
      -- Rows exist but not one email left. Nobody has been asked, whatever the
      -- rows look like, so this is not a day that is calmly waiting.
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
