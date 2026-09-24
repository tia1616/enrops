-- Code-review fixes to 20260923a. Three defects, all in the same SELECT, so
-- they move together rather than as three patches on one function.
--
-- 1. A DAY TWO PEOPLE REFUSED WENT QUIET. 20260923a made a single unanswered
--    offer outrank every decline on the day: any pending row at all produced
--    state='awaiting'. NeedsCoverBanner renders only 'uncovered', and the
--    homescreen files 'awaiting' as a priority-9 note reading "just waiting to
--    hear back". So: lead out on Oct 5, offered to Ann, Bo and Cal; Ann
--    declines, Bo declines, Cal never opens the email -- and the product tells
--    the operator to sit tight. The OLD per-row body returned an 'uncovered'
--    row for each decline and DID raise the alarm, so this was a regression
--    that made a coverage alarm quieter than the code it replaced.
--    Fixed with a third state. A day nobody has accepted is now:
--      'uncovered' - somebody said no and no offer is live  -> act
--      'at_risk'   - somebody said no AND an offer is live  -> act
--      'awaiting'  - offers are out and nobody has said no  -> calm
--    The rule this function applies: within a day, a decline is never erased by
--    a live offer. Only an ACCEPTANCE clears a day, and an accepted day is
--    excluded by the HAVING below.
--
--    HONEST LIMIT, and it is the important part: 'at_risk' cannot fire yet.
--    create-assignment-substitution UPSERTS on
--    (parent_assignment_id, parent_assignment_type, date) and writes
--    status='pending', so re-offering a declined day OVERWRITES the declined row
--    rather than adding to it -- the decline is destroyed, decline_count goes
--    back to 0, and the day reads 'awaiting' again. No aggregation can see a row
--    that no longer exists. So on today's live path an operator re-offering a
--    refused day still loses the record that anyone refused it. Closing that is
--    chunk 2's job, where the upsert becomes an insert; this function is ready
--    for it and inert until then. It also leaves declined_at and decline_reason
--    STALE on the now-pending row, which anything reading declined_at (the
--    instructor contact timeline does) will misread.
--
-- 2. COUNTS WERE ROWS, THE COPY SAID PEOPLE. offers_out and decline_count were
--    count(*), but every sentence built on them speaks about people ("3 offers
--    out", "2 people declined"). Once the one-row-per-day constraint goes,
--    re-offering a day to someone who already declined it leaves TWO declined
--    rows for one human, and the banner would say "2 people declined" about
--    one person -- and, because the old decliner_name test was `= 1`, drop her
--    name at the same time. Both counts are now distinct instructors.
--
-- 3. decliner_name WAS NOT GATED ON STATE. 20260923a computed it from the
--    decline count alone, so a day with one decline and one live offer could
--    return state='awaiting' WITH a decliner name -- a combination the old body
--    could not produce and no reader expects. It is now emitted only for the
--    states where nobody has accepted and exactly one person said no.
--
-- NOT CHANGED, and worth saying so: rows are per COVERAGE SLOT (parent
-- assignment + date), not per calendar day. A camp session staffed by both a
-- lead and a developing instructor is two assignments, so if both are out on
-- one day this returns two rows -- correctly, because that day needs two
-- people. 20260923a's comment claimed one row was one class-day, which is
-- false for the 10 camp sessions on production that carry both roles.
-- Both readers therefore count ROWS and call them class days: over-counting a
-- twin-role camp day by one is the safe direction, where deduping on the date
-- would collapse two different classes uncovered on the same Monday into "1 day
-- needs cover" and leave one of them empty.

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
  decline_count          integer
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  with offer_rows as (
    -- Camp half. Only offers whose parent camp assignment and session are still
    -- alive, so a withdrawn assignment or a cancelled session cannot leave a
    -- stale alarm on the board.
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

    -- After-school half. Same liveness rule against the program assignment and
    -- the class itself. `coalesce` because programs.status is NULLABLE: a bare
    -- `<> 'cancelled'` yields NULL for a null status and the inner join drops
    -- the row, hiding an uncovered day with no error. Zero nulls today; the
    -- guard is what stops that being luck.
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
      -- People, not rows: the same person can hold more than one row for a day
      -- once a day can be offered more than once.
      count(distinct r.sub_instructor_id) filter (where r.status = 'pending')::int as offers_out,
      -- A PERSON who turned the class down. accept_sub_offer stamps everyone who
      -- LOST a first-come race as declined with decline_reason='covered_by_other'
      -- -- they said YES and were closed out by somebody faster. Counting them
      -- here would tell an operator "3 people declined" about two people still
      -- free to ask, and the single-decline branch would name one of them
      -- personally for a refusal that never happened.
      count(distinct r.sub_instructor_id) filter (
        where r.status = 'declined' and r.decline_reason is distinct from 'covered_by_other'
      )::int as decline_count,
      -- Name the decliner only when there is exactly ONE of them; with several,
      -- naming one would be a false statement about the others.
      case when count(distinct r.sub_instructor_id) filter (
             where r.status = 'declined' and r.decline_reason is distinct from 'covered_by_other'
           ) = 1
           then max(r.instructor_name) filter (
             where r.status = 'declined' and r.decline_reason is distinct from 'covered_by_other'
           )
      end as decliner_name
    from offer_rows r
    group by r.parent_assignment_id, r.parent_assignment_type, r.slot_date
    -- A day somebody accepted is covered: say nothing about it. A day holding
    -- only 'missed' rows is not a coverage question either.
    having count(*) filter (where r.status in ('confirmed', 'taught')) = 0
       and count(*) filter (where r.status in ('pending', 'declined')) > 0
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
    s.decline_count
  from slots s;
$$;

-- Grants. `REVOKE ... FROM public` does NOT remove anon's EXECUTE: a function
-- created in this schema is born with an EXPLICIT anon grant from Supabase's
-- default privileges, and only an explicit REVOKE FROM anon removes it. Read
-- pg_proc.proacl back after applying. Target, unchanged from 20260702:
--   {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
REVOKE ALL ON FUNCTION public.get_sub_coverage(uuid) FROM public;
REVOKE EXECUTE ON FUNCTION public.get_sub_coverage(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_sub_coverage(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sub_coverage(uuid) TO service_role;

-- Same trap, same feature, found by the review: accept_sub_offer and
-- sub_availability_on_date were created by 20260723b/c with `REVOKE ALL FROM
-- public` and no revoke of anon by name, so BOTH carry anon=X on production
-- today despite 20260723c declaring accept_sub_offer service-role only. Not
-- exploitable -- both are SECURITY INVOKER and anon satisfies no RLS policy on
-- assignment_substitutions -- but chunk 2 makes accept_sub_offer the function
-- that decides who gets a class, and a write path should not carry a grant its
-- own migration says it does not have.
REVOKE EXECUTE ON FUNCTION public.accept_sub_offer(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.sub_availability_on_date(uuid, date, text, uuid) FROM anon;
