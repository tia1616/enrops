-- Round 2 of the chunk-2 review fixes: three defects the independent reviewers
-- found IN THE FIRST ROUND OF FIXES. All three are cases where a guard written
-- yesterday was narrower than the thing it claimed to guard.
--
-- A. A RELEASED DAY IS NOT ALWAYS A DAY THAT NEEDS SOMEBODY. Round 1 made every
--    'cancelled' row raise the coverage alarm. But the most ordinary reason to
--    release a cover is that the REGULAR INSTRUCTOR is available after all -
--    and then the day is fine, nobody is needed, and the alarm can never be
--    cleared: there is no dismiss, no delete, and the banner's own advice ("or
--    the lead can take it back") is the thing that already happened. An alarm
--    that cannot be cleared is worse than the silence round 1 set out to fix,
--    because an operator learns to ignore it. The release now records WHICH of
--    the two it was, and only "I still need somebody" alarms.
--
-- B. THE DOUBLE-BOOKING GUARD ONLY SAW HALF OF WHAT MAKES SOMEBODY BUSY. Round
--    1 refused an accept that overlapped another SUBSTITUTION the same person
--    had already taken. It did not look at the class that person teaches
--    THEMSELVES, which is the common case and the one the picker already warns
--    about ("already teaching an after-school class at that time"). Ann's own
--    Chess class runs Tuesday 3:30; she could still accept a 3:30 sub offer,
--    and two rooms expected her.
--
--    The fix puts every kind of commitment behind ONE function rather than
--    adding a second list to accept_sub_offer. Note it EXCLUDES a class of
--    their own that somebody else is already covering - they are genuinely free
--    then, and refusing would be a wrong refusal nobody could talk the database
--    out of.
--
-- C. THE LOSER EMAIL WENT TO PEOPLE WHO WERE NEVER ASKED. accept_sub_offer
--    closes every sibling 'pending' row and hands them back to be emailed "that
--    day is covered". A row whose offer email never left is still pending, so
--    somebody who was never contacted got told about a shift, at a named site,
--    on a named date, that somebody else had won. Closing the row is right;
--    telling them is not. The close-out is unchanged and the PAYLOAD is
--    filtered - that distinction is the whole fix.

-- --------------------------------------------------------------- A. the why --
alter table public.assignment_substitutions
  add column if not exists cover_still_needed boolean;

comment on column public.assignment_substitutions.cover_still_needed is
  'Set with status=cancelled. TRUE: the cover was released and the day still '
  'needs somebody, so it raises the coverage alarm. FALSE: released because the '
  'class no longer needs a sub at all (the regular is teaching it after all), so '
  'the day is settled and silent. NULL on rows that were never cancelled.';

-- ------------------------------------------- B. what makes a person busy --
-- Every commitment one instructor has on one date, as time windows. ONE
-- spelling, so accept_sub_offer does not grow a second copy of "does this class
-- run that day" and drift from sub_availability_on_date.
--
-- A NULL window means the time is not knowable (a malformed start_time, a
-- missing parent). Callers must read NULL as "do not know" and must NOT treat
-- it as a conflict: sub_availability_on_date does treat it as one, which is
-- right for greying a name out in a picker and wrong for a hard refusal that
-- would leave the class uncovered anyway.
create or replace function public.instructor_commitments_on_date(
  p_instructor uuid, p_date date
)
returns table(source text, ref_id uuid, ts time, te time)
language sql
stable
set search_path to 'public'
as $function$
  with wk as (
    select (array['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])
             [extract(dow from p_date)::int + 1] as lname
  )
  -- Their own after-school class, if it runs that day and nobody is covering it.
  select 'teaching'::text, pa.id, w.ts, w.te
    from program_assignments pa
    join programs pr on pr.id = pa.program_id
    cross join lateral sub_slot_window('program', pa.id) w
   where pa.instructor_id = p_instructor
     and coalesce(pa.status, '') <> 'declined'
     and lower(btrim(pr.day_of_week)) = (select lname from wk)
     and p_date >= pr.first_session_date
     and p_date <= coalesce(
           pr.end_date,
           pr.first_session_date
             + ((greatest(coalesce(pr.session_count, pr.sessions, 1), 1) - 1) * 7))
     and not exists (
       select 1 from assignment_substitutions s
        where s.parent_assignment_id = pa.id
          and s.parent_assignment_type = 'program'
          and s.date = p_date
          and s.status in ('confirmed', 'taught'))

  union all

  -- Their own camp, same rule.
  select 'camp', ca.id, w.ts, w.te
    from camp_assignments ca
    join camp_sessions cs on cs.id = ca.camp_session_id
    cross join lateral sub_slot_window('camp', ca.id) w
   where ca.instructor_id = p_instructor
     and coalesce(ca.status, '') <> 'declined'
     and p_date >= cs.starts_on
     and p_date <= cs.ends_on
     and (cs.class_days is null or (select lname from wk) = any(cs.class_days))
     and not exists (
       select 1 from assignment_substitutions s
        where s.parent_assignment_id = ca.id
          and s.parent_assignment_type = 'camp'
          and s.date = p_date
          and s.status in ('confirmed', 'taught'))

  union all

  -- A day they are already covering for somebody else. Only settled rows: a
  -- live OFFER must not make somebody look busy, or asking two people about the
  -- same afternoon would take them both out of the running.
  select 'subbing', s.parent_assignment_id, w.ts, w.te
    from assignment_substitutions s
    cross join lateral sub_slot_window(s.parent_assignment_type, s.parent_assignment_id) w
   where s.sub_instructor_id = p_instructor
     and s.date = p_date
     and s.status in ('confirmed', 'taught');
$function$;

revoke execute on function public.instructor_commitments_on_date(uuid, date) from public;
revoke execute on function public.instructor_commitments_on_date(uuid, date) from anon;
revoke execute on function public.instructor_commitments_on_date(uuid, date) from authenticated;

-- ---------------------------------------- B + C. accept_sub_offer, widened --
create or replace function public.accept_sub_offer(p_substitution_id uuid, p_sub_instructor_id uuid)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
DECLARE
  v_row     assignment_substitutions%ROWTYPE;
  v_losers  jsonb;
  v_ts      time;
  v_te      time;
BEGIN
  SELECT * INTO v_row FROM assignment_substitutions
   WHERE id = p_substitution_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_row.sub_instructor_id IS DISTINCT FROM p_sub_instructor_id THEN
    RETURN jsonb_build_object('outcome', 'forbidden');
  END IF;

  IF v_row.status <> 'pending' THEN
    RETURN jsonb_build_object('outcome', 'already_responded', 'status', v_row.status);
  END IF;

  -- Already committed somewhere that overlaps this class? Provable overlap
  -- only: both windows known and actually crossing.
  SELECT w.ts, w.te INTO v_ts, v_te
    FROM sub_slot_window(v_row.parent_assignment_type, v_row.parent_assignment_id) w;

  IF v_ts IS NOT NULL AND v_te IS NOT NULL AND EXISTS (
    SELECT 1
      FROM instructor_commitments_on_date(p_sub_instructor_id, v_row.date) c
     WHERE c.ts IS NOT NULL AND c.te IS NOT NULL
       AND NOT (c.source = 'subbing' AND c.ref_id = v_row.parent_assignment_id)
       AND v_ts < c.te AND c.ts < v_te
  ) THEN
    RETURN jsonb_build_object('outcome', 'time_conflict');
  END IF;

  BEGIN
    UPDATE assignment_substitutions
       SET status = 'confirmed', updated_at = now()
     WHERE id = p_substitution_id;
  EXCEPTION WHEN unique_violation THEN
    UPDATE assignment_substitutions
       SET status = 'declined', declined_at = now(),
           decline_reason = 'covered_by_other', updated_at = now()
     WHERE id = p_substitution_id AND status = 'pending';
    RETURN jsonb_build_object('outcome', 'lost');
  END;

  WITH sib AS (
    SELECT s.id
      FROM assignment_substitutions s
     WHERE s.parent_assignment_id   = v_row.parent_assignment_id
       AND s.parent_assignment_type = v_row.parent_assignment_type
       AND s.date                   = v_row.date
       AND s.status = 'pending'
       AND s.id <> p_substitution_id
     FOR UPDATE SKIP LOCKED
  ),
  upd AS (
    -- EVERY sibling is closed, emailed or not: a row left pending would keep a
    -- live Accept button on a day that is gone.
    UPDATE assignment_substitutions s
       SET status = 'declined', declined_at = now(),
           decline_reason = 'covered_by_other', updated_at = now()
      FROM sib
     WHERE s.id = sib.id
     RETURNING s.sub_instructor_id, s.email_sent_at
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'sub_instructor_id', i.id,
           'email',             i.email,
           'first_name',        i.first_name,
           'preferred_name',    i.preferred_name
         )), '[]'::jsonb)
    INTO v_losers
    FROM upd JOIN instructors i ON i.id = upd.sub_instructor_id
    -- ...but only somebody who was actually ASKED can be told the answer.
    -- A row whose offer email never left belongs to a person who has never
    -- heard of this class, and "that day is covered" would be their first news
    -- of a shift at a named site on a named date that somebody else won.
   WHERE upd.email_sent_at IS NOT NULL;

  RETURN jsonb_build_object('outcome', 'won', 'losers', v_losers);
END;
$function$;

revoke execute on function public.accept_sub_offer(uuid, uuid) from public;
revoke execute on function public.accept_sub_offer(uuid, uuid) from anon;
revoke execute on function public.accept_sub_offer(uuid, uuid) from authenticated;

-- ------------------------------------- A. the alarm respects the reason --
-- Only the cancelled rows that still WANT somebody are counted. Everything else
-- in this function is unchanged from 20260923g.
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
