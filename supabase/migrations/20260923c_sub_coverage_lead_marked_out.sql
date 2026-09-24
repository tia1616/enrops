-- A day the instructor TOLD US they cannot make now reaches the coverage alarm.
--
-- THE GAP. Instructors report the dates they are unavailable in the term
-- availability survey, and on production 11 of them have reported 42 dates.
-- Two of those land on a day the person is actually teaching -- and nothing
-- carried that forward. The coral banner and the homescreen card only ever knew
-- about sub OFFERS, so a class-day whose instructor has already said "I am out"
-- was silent everywhere until somebody thought to ask for a sub. Measured
-- 2026-09-23: both live ones are still upcoming and neither has had an offer
-- sent. The signal was complete and correct; it just never reached the alarm.
--
-- THE NEW STATE: 'lead_out' -- the assigned instructor marked this class date
-- unavailable and NOBODY HAS BEEN ASKED yet. It is deliberately its own state
-- rather than folded into 'uncovered', because 'uncovered' means somebody was
-- asked and said no, and the homescreen says exactly that. Telling an operator
-- "someone said no" about a day nobody has been asked about is the kind of
-- confidently-wrong sentence this whole surface exists to stop.
--
-- Precedence, unchanged for every day that already has an offer on it: the
-- moment ANY sub row exists for a class-day, that row's own state governs
-- (covered / awaiting / at_risk / uncovered). 'lead_out' only ever describes a
-- day with no sub row at all, so the two can never both speak for one day.
--
-- WHY THE DATES ARE RIGHT. Session dates come from derive_program_session_dates_bulk
-- -- the canonical function, called ONCE for every program rather than once per
-- program in a correlated subquery. The single-program version costs ~189ms
-- under the real authenticated role, and this function feeds the homescreen, so
-- a per-program call here would have put seconds on the page that greets an
-- operator. The bulk version exists (20260907d) for exactly this reason.
--
-- AFTER-SCHOOL ONLY, on purpose. Camps derive their meeting days from a session
-- date range plus class_days rather than from a session-date function, which is
-- a genuinely different rule, and camp is mostly a summer product. The camp
-- board keeps showing its own per-card "out - needs a sub" flag as before; it
-- just does not reach this alarm yet. Same deliberate divergence already
-- recorded for the same-day conflict rule.
--
-- WHICH SURVEY TABLE. instructor_term_availability is the live one: 30 rows, 16
-- carrying dates, all term FA26. The older instructor_availability has 15 rows
-- and ZERO unavailable dates on production -- legacy, deliberately not read.
-- We match on the DATE alone and ignore which term row it came from: a person
-- who says they are away on 8 Oct is away on 8 Oct whichever term they filed it
-- under, and the date itself is unambiguous.
--
-- SECURITY: unchanged. SECURITY INVOKER, so the caller's RLS decides what they
-- can see -- instructor_term_availability already carries an org-member read
-- policy, so an operator sees their own org and nothing else. The bulk dates
-- function is SECURITY DEFINER, but every program id handed to it has already
-- been filtered to p_org and past the caller's own RLS on program_assignments
-- and programs, so it cannot widen what comes back.

DROP FUNCTION IF EXISTS public.get_sub_coverage(uuid);

CREATE FUNCTION public.get_sub_coverage(p_org uuid)
RETURNS TABLE (
  parent_assignment_id   uuid,
  parent_assignment_type text,
  slot_date              date,
  state                  text,
  decliner_name          text,
  curriculum_label       text,
  location_label         text,
  offers_out             integer,
  decline_count          integer,
  lead_out_name          text
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  with offer_rows as (
    select
      a.parent_assignment_id                as parent_assignment_id,
      'camp'::text                          as parent_assignment_type,
      a.date                                as slot_date,
      a.status                              as status,
      a.sub_instructor_id                   as sub_instructor_id,
      a.decline_reason                      as decline_reason,
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
      count(distinct r.sub_instructor_id) filter (where r.status = 'pending')::int as offers_out,
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
       and count(*) filter (where r.status in ('pending', 'declined')) > 0
  ),
  -- Live after-school assignments in this org, with their real class dates.
  -- One bulk call, never one per program.
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
      -- the instructor said they are unavailable on this exact date
      and exists (
        select 1
        from instructor_term_availability ta
        where ta.instructor_id = la.instructor_id
          and d::date = any (ta.unavailable_dates)
      )
      -- and nobody has been asked to cover it. Any sub row at all, in any
      -- state, means the offer's own state already speaks for this day.
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
      when s.decline_count > 0 and s.offers_out > 0 then 'at_risk'
      when s.decline_count > 0                      then 'uncovered'
      else                                               'awaiting'
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
$$;

-- Grants. `REVOKE ... FROM public` does NOT remove anon's EXECUTE: a function
-- created in this schema is born with an EXPLICIT anon grant from Supabase's
-- default privileges, and only an explicit REVOKE FROM anon removes it. Read
-- pg_proc.proacl back after applying. Target, unchanged since 20260702:
--   {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
REVOKE ALL ON FUNCTION public.get_sub_coverage(uuid) FROM public;
REVOKE EXECUTE ON FUNCTION public.get_sub_coverage(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_sub_coverage(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sub_coverage(uuid) TO service_role;
