-- get_sub_coverage answers ONE question per CLASS-DAY, not per offer row.
--
-- WHY (this is the whole point of the migration):
-- The old body selected offer ROWS `where status in ('pending','declined')` and
-- mapped each row straight to a state. That is only correct while
-- UNIQUE (parent_assignment_id, parent_assignment_type, date) guarantees at most
-- ONE offer per class-day. The first-come sub build removes that constraint
-- (offer one day to several people, first yes wins), and the moment a day can
-- hold several offers the old body is wrong in two ways:
--
--   1. One day with 3 offers out counted as THREE "awaiting" signals on the
--      homescreen -- three rows, three days apparently waiting, one real day.
--   2. Worse, and caused by SUCCESS: when somebody accepts, accept_sub_offer
--      (20260723c) confirms the winner and records every losing offer as
--      'declined'. The old body did not select 'confirmed' AT ALL, so the
--      winner was invisible to it while the losers were not -- a day that is
--      now COVERED would render on the homescreen and in NeedsCoverBanner as
--      "2 days need cover", naming two people who never turned the class down.
--
-- WHAT CHANGES: the base query now sees EVERY status for the day (confirmed and
-- taught included), then aggregates per (parent_assignment_id, type, date):
--     any confirmed/taught  -> covered, not returned at all
--     else any pending      -> 'awaiting'  (offers_out = how many are out)
--     else any declined     -> 'uncovered' (decline_count = how many declined)
-- A day with only 'missed' rows is still returned by nothing, exactly as before.
--
-- BACKWARD COMPATIBLE BY CONSTRUCTION: while one row per day is still the rule,
-- every group has exactly one row, so state and decliner_name resolve to the
-- same values the old body produced. The two new columns are additive; existing
-- readers (AdminOverview's ImportantToday, NeedsCoverBanner) ignore what they do
-- not select. Proven empirically against both databases in the same pass.
--
-- decliner_name is deliberately NULL when more than one person declined: a name
-- would have to pick one of them, and "Ann declined" is not true of a day Ann
-- and Bo both declined. The count carries that case instead, so the banner can
-- say "2 people declined" rather than asserting something false about one of
-- them.
--
-- NOT HANDLED HERE, ON PURPOSE: accept_sub_offer stamps losing offers with
-- decline_reason = 'covered_by_other'. This function does not read that value,
-- and does not need to -- a day with a winner is excluded by the confirmed/taught
-- test before any decline is looked at. If a future "cancel a confirmed sub"
-- path ever makes it possible for a day to hold covered_by_other declines with
-- NO winner, that state must get a real flag of its own rather than a string
-- match on a free-text column the instructor can type into.
--
-- SECURITY: unchanged. SECURITY INVOKER (RLS applies to the caller), STABLE,
-- pinned search_path, EXECUTE to authenticated + service_role only, never anon.
-- The return type gains columns, so this is DROP + CREATE rather than
-- CREATE OR REPLACE -- which drops the grants with it, hence the explicit
-- re-grant below. Both statements run in one transaction, so no caller sees a
-- window where the function is missing.

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
     and cs.status = 'active'
    left join instructors i on i.id = a.sub_instructor_id
    where a.organization_id = p_org
      and a.parent_assignment_type = 'camp'
      and a.date >= current_date

    union all

    -- After-school half. Same liveness rule against the program assignment and
    -- the class itself.
    select
      a.parent_assignment_id,
      'program'::text,
      a.date,
      a.status,
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
     and p.status <> 'cancelled'
    left join program_locations pl on pl.id = p.program_location_id
    left join instructors i on i.id = a.sub_instructor_id
    where a.organization_id = p_org
      and a.parent_assignment_type = 'program'
      and a.date >= current_date
  )
  select
    r.parent_assignment_id,
    r.parent_assignment_type,
    r.slot_date,
    case when count(*) filter (where r.status = 'pending') > 0
         then 'awaiting'
         else 'uncovered'
    end                                                          as state,
    case when count(*) filter (where r.status = 'declined') = 1
         then max(r.instructor_name) filter (where r.status = 'declined')
    end                                                          as decliner_name,
    max(r.curriculum_label)                                      as curriculum_label,
    max(r.location_label)                                        as location_label,
    count(*) filter (where r.status = 'pending')::int            as offers_out,
    count(*) filter (where r.status = 'declined')::int           as decline_count
  from offer_rows r
  group by r.parent_assignment_id, r.parent_assignment_type, r.slot_date
  -- A day somebody is confirmed for is covered: say nothing about it. A day
  -- holding only 'missed' rows is not a coverage question either.
  having count(*) filter (where r.status in ('confirmed', 'taught')) = 0
     and count(*) filter (where r.status in ('pending', 'declined')) > 0;
$$;

-- Grants. `REVOKE ... FROM public` does NOT remove anon's EXECUTE: a function
-- created in this schema is born with an EXPLICIT anon grant from Supabase's
-- default privileges, and only an explicit REVOKE FROM anon removes it. Measured
-- on staging while applying this migration -- the fresh function came up with
-- anon=X/postgres even though nothing here granted it, which would have WIDENED
-- the old function's ACL. Revoke anon by name, then read pg_proc.proacl back.
-- The target ACL is exactly what the old function had:
--   {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
REVOKE ALL ON FUNCTION public.get_sub_coverage(uuid) FROM public;
REVOKE EXECUTE ON FUNCTION public.get_sub_coverage(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_sub_coverage(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sub_coverage(uuid) TO service_role;
