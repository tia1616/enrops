-- A SUB DAY HAPPENS ON A DATE, AND EVERY SUB CHECK READ THE CLASS'S USUAL WEEK.
--
-- Found 2026-10-21 (The Ukulele Project, a real sub refused). A sub was offered
-- an Alameda class on 10/21 and accepting returned time_conflict. Both halves
-- of the check were date-blind:
--
--   1. instructor_commitments_on_date said he was teaching his own St. Clare
--      class 3:10-3:55 that afternoon. St. Clare's district calendar has 10/21
--      as a no-school day (conferences), and derive_program_session_schedule
--      already returns it as no_school. The commitment test was "right weekday,
--      inside first_session_date..end" - it never asked the schedule.
--   2. sub_slot_window said the Alameda class runs 2:35-3:20. 10/21 is an early
--      release day there and the class is opted in at 11:55-12:40, which the
--      schedule also already returns. The window read programs.start_time.
--
--   The calendar data was right; the sub checks never read it.
--
-- THE RULE NOW LIVES IN ONE PLACE: derive_program_session_schedule, the
-- function the instructor portal, the parent dashboard and payroll already
-- read. Nothing here re-derives a closure or an early release.
--
--   program_session_times_on(program, date)  the class's times ON THAT DATE:
--       the early-release times on a kept early-release date, the usual times
--       otherwise. The one source for every sub surface: the accept check, the
--       picker, the sub's portal card, the offer email.
--   sub_slot_window(type, assignment, DATE)  now REQUIRES the date. The
--       two-argument version is DROPPED, not overloaded, so nothing can keep
--       calling the date-blind spelling by accident.
--   instructor_commitments_on_date  a class of their own is a commitment only
--       if the schedule says it MEETS that date (kind = 'session'), and only if
--       the class is running (not cancelled / draft - the same exclude list as
--       the instructor portal and _shared/programRunning.ts).
--   sub_availability_on_date (the picker)  carried its OWN inline copy of both
--       bugs. It now reads instructor_commitments_on_date and sub_slot_window,
--       so the picker and the accept check cannot disagree again. Its own
--       policy is kept: an unknown time greys a name out in the picker, while
--       accept_sub_offer still ignores an unknown time rather than refuse.
--   get_my_sub_details  the sub's portal card read programs.start_time; it now
--       returns that day's times plus an early_release flag.
--
-- CAMPS ARE UNCHANGED. A camp ignores the district calendar by design (school
-- being out is why it runs); its window stays camp_sessions.start/end_time and
-- its commitment test stays starts_on..ends_on + class_days.
--
-- GRANTS - widened on purpose, BEFORE / AFTER / GAINED:
--   sub_slot_window, instructor_commitments_on_date
--     BEFORE postgres, service_role.  AFTER + authenticated.
--     GAINED: sub_availability_on_date is SECURITY INVOKER and runs as the
--     signed-in operator, so it can only call these if authenticated can. Both
--     are SECURITY INVOKER plain reads: a caller sees only the assignment,
--     substitution and program rows RLS already lets them select directly.
--     anon stays revoked.
--   program_session_times_on (new)  authenticated + service_role, anon revoked.

-- -------------------------------------------------- the one date-aware read --
create or replace function public.program_session_times_on(p_program_id uuid, p_date date)
returns table(start_time text, end_time text, early_release boolean)
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  -- A date the schedule does not list as a session (a no-school day, a date
  -- outside the term) falls back to the usual times: this answers "what time",
  -- never "does it meet". Callers that need "does it meet" ask the schedule.
  select case when e.entry_date is not null then e.session_time     else pr.start_time end,
         case when e.entry_date is not null then e.session_end_time else pr.end_time   end,
         coalesce(e.reason = 'Early release', false)
    from programs pr
    left join lateral (
      select x.entry_date, x.session_time, x.session_end_time, x.reason
        from derive_program_session_schedule(pr.id) x
       where x.entry_date = p_date
         and x.kind = 'session'
       limit 1
    ) e on true
   where pr.id = p_program_id;
$function$;

revoke execute on function public.program_session_times_on(uuid, date) from public;
revoke execute on function public.program_session_times_on(uuid, date) from anon;
grant  execute on function public.program_session_times_on(uuid, date) to authenticated;
grant  execute on function public.program_session_times_on(uuid, date) to service_role;

-- ------------------------------------------------------- the slot, on a date --
drop function if exists public.sub_slot_window(text, uuid);

create or replace function public.sub_slot_window(
  p_parent_type text, p_parent_assignment_id uuid, p_date date
)
returns table(ts time, te time)
language sql
stable
set search_path to 'public'
as $function$
  select cs.start_time, cs.end_time
    from camp_assignments ca
    join camp_sessions cs on cs.id = ca.camp_session_id
   where p_parent_type = 'camp' and ca.id = p_parent_assignment_id
  union all
  -- Same parse as before (12-hour text only, NULL otherwise): this change is
  -- about WHICH times, not how they are read.
  select
    case when t.start_time ~* '^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$'
         then to_timestamp(t.start_time, 'HH12:MI AM')::time end,
    case when t.end_time ~* '^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$'
         then to_timestamp(t.end_time, 'HH12:MI AM')::time end
    from program_assignments pa
    cross join lateral program_session_times_on(pa.program_id, p_date) t
   where p_parent_type = 'program' and pa.id = p_parent_assignment_id;
$function$;

revoke execute on function public.sub_slot_window(text, uuid, date) from public;
revoke execute on function public.sub_slot_window(text, uuid, date) from anon;
grant  execute on function public.sub_slot_window(text, uuid, date) to authenticated;
grant  execute on function public.sub_slot_window(text, uuid, date) to service_role;

-- ------------------------------------------- what makes a person busy, dated --
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
  -- Their own after-school class, if the SCHEDULE says it meets that day and
  -- nobody is covering it. A no-school day is not a commitment.
  select 'teaching'::text, pa.id, w.ts, w.te
    from program_assignments pa
    join programs pr on pr.id = pa.program_id
    cross join lateral sub_slot_window('program', pa.id, p_date) w
   where pa.instructor_id = p_instructor
     and coalesce(pa.status, '') <> 'declined'
     and coalesce(pr.status, '') not in ('cancelled', 'draft')
     and p_date >= pr.first_session_date
     -- Cheap pre-filter only, so the schedule is walked for few programs. It is
     -- exactly the walk's own cadence: a weekly class steps 7 days from
     -- first_session_date; a class_days program is left to the schedule.
     and (coalesce(array_length(pr.class_days, 1), 0) > 0
          or extract(dow from p_date) = extract(dow from pr.first_session_date))
     and exists (
       select 1 from derive_program_session_schedule(pr.id) x
        where x.entry_date = p_date and x.kind = 'session')
     and not exists (
       select 1 from assignment_substitutions s
        where s.parent_assignment_id = pa.id
          and s.parent_assignment_type = 'program'
          and s.date = p_date
          and s.status in ('confirmed', 'taught'))

  union all

  select 'camp', ca.id, w.ts, w.te
    from camp_assignments ca
    join camp_sessions cs on cs.id = ca.camp_session_id
    cross join lateral sub_slot_window('camp', ca.id, p_date) w
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
    cross join lateral sub_slot_window(s.parent_assignment_type, s.parent_assignment_id, s.date) w
   where s.sub_instructor_id = p_instructor
     and s.date = p_date
     and s.status in ('confirmed', 'taught');
$function$;

revoke execute on function public.instructor_commitments_on_date(uuid, date) from public;
revoke execute on function public.instructor_commitments_on_date(uuid, date) from anon;
grant  execute on function public.instructor_commitments_on_date(uuid, date) to authenticated;
grant  execute on function public.instructor_commitments_on_date(uuid, date) to service_role;

-- ------------------------------------------------- accept: pass the date --
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

  -- The slot ON THIS DATE: an early-release day is a different window.
  SELECT w.ts, w.te INTO v_ts, v_te
    FROM sub_slot_window(v_row.parent_assignment_type, v_row.parent_assignment_id, v_row.date) w;

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
   WHERE upd.email_sent_at IS NOT NULL;

  RETURN jsonb_build_object('outcome', 'won', 'losers', v_losers);
END;
$function$;

revoke execute on function public.accept_sub_offer(uuid, uuid) from public;
revoke execute on function public.accept_sub_offer(uuid, uuid) from anon;
revoke execute on function public.accept_sub_offer(uuid, uuid) from authenticated;

-- ---------------------------------------- the picker reads the same rule --
create or replace function public.sub_availability_on_date(
  p_org uuid, p_date date, p_parent_type text, p_parent_assignment_id uuid
)
returns table(instructor_id uuid, is_working boolean, working_reason text, is_date_off boolean,
              day_time_match text, out_of_area boolean, tight_gap boolean)
language sql
stable
set search_path to 'public'
as $function$
  WITH d AS (
    SELECT p_date AS dt, EXTRACT(DOW FROM p_date)::int AS dow
  ),
  wk AS (
    SELECT
      (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[(SELECT dow FROM d) + 1] AS key3
  ),
  tgt AS (
    SELECT
      (SELECT lower(trim(pl.district))
         FROM program_assignments pa
         JOIN programs pr ON pr.id = pa.program_id
         JOIN program_locations pl ON pl.id = pr.program_location_id
        WHERE pa.id = p_parent_assignment_id AND pl.district IS NOT NULL)           AS target_district,
      (SELECT cs.session_type
         FROM camp_assignments ca JOIN camp_sessions cs ON cs.id = ca.camp_session_id
        WHERE ca.id = p_parent_assignment_id)                                       AS target_session_type
  ),
  -- The slot ON THIS DATE (early release included) - the same window
  -- accept_sub_offer checks.
  target_win AS (
    SELECT w.ts, w.te
      FROM sub_slot_window(p_parent_type, p_parent_assignment_id, p_date) w
     LIMIT 1
  ),
  -- Everything that makes each person busy that date - the same function
  -- accept_sub_offer refuses on, so a name the picker shows as free cannot be
  -- refused at accept for a reason the picker did not see, and vice versa.
  booked AS (
    SELECT i.id AS instructor_id, c.source AS reason,
           CASE c.source WHEN 'teaching' THEN 1 WHEN 'camp' THEN 2 ELSE 3 END AS pri,
           c.ts AS s, c.te AS e
      FROM instructors i
      CROSS JOIN LATERAL instructor_commitments_on_date(i.id, p_date) c
     WHERE i.organization_id = p_org
  ),
  cmp AS (
    SELECT b.instructor_id, b.reason, b.pri,
      (
        (SELECT ts FROM target_win) IS NULL
        OR (SELECT te FROM target_win) IS NULL
        OR b.s IS NULL OR b.e IS NULL
        OR ((SELECT ts FROM target_win) < b.e AND b.s < (SELECT te FROM target_win))
      ) AS is_conflict,
      CASE
        WHEN b.s IS NOT NULL AND b.e IS NOT NULL
         AND (SELECT ts FROM target_win) IS NOT NULL
         AND (SELECT te FROM target_win) IS NOT NULL
        THEN CASE
               WHEN b.s >= (SELECT te FROM target_win)
                 THEN EXTRACT(EPOCH FROM (b.s - (SELECT te FROM target_win))) / 60
               ELSE EXTRACT(EPOCH FROM ((SELECT ts FROM target_win) - b.e)) / 60
             END
      END AS gap_min
    FROM booked b
    WHERE b.instructor_id IS NOT NULL
  ),
  working AS (
    SELECT DISTINCT ON (instructor_id) instructor_id, reason
    FROM cmp
    WHERE is_conflict
    ORDER BY instructor_id, pri
  ),
  tight AS (
    SELECT DISTINCT instructor_id
    FROM cmp
    WHERE NOT is_conflict AND gap_min IS NOT NULL AND gap_min < 60
  ),
  off_dates AS (
    SELECT instructor_id FROM instructor_term_availability
      WHERE organization_id = p_org AND (SELECT dt FROM d) = ANY(unavailable_dates)
    UNION
    SELECT instructor_id FROM instructor_availability
      WHERE organization_id = p_org AND (SELECT dt FROM d) = ANY(unavailable_dates)
  ),
  ita_latest AS (
    SELECT DISTINCT ON (instructor_id) instructor_id, weekday_availability
    FROM instructor_term_availability
    WHERE organization_id = p_org
      AND weekday_availability IS NOT NULL AND weekday_availability <> '{}'::jsonb
    ORDER BY instructor_id, COALESCE(updated_at, submitted_at, created_at) DESC NULLS LAST
  ),
  ia_latest AS (
    SELECT DISTINCT ON (instructor_id) instructor_id, session_types
    FROM instructor_availability
    WHERE organization_id = p_org
      AND session_types IS NOT NULL AND array_length(session_types, 1) > 0
    ORDER BY instructor_id, COALESCE(updated_at, submitted_at, created_at) DESC NULLS LAST
  )
  SELECT
    i.id AS instructor_id,
    (w.instructor_id IS NOT NULL) AS is_working,
    w.reason AS working_reason,
    (o.instructor_id IS NOT NULL) AS is_date_off,
    CASE
      WHEN p_parent_type = 'program' THEN (
        CASE
          WHEN il.weekday_availability IS NULL THEN 'none'
          WHEN NOT jsonb_exists(il.weekday_availability, (SELECT key3 FROM wk)) THEN 'day'
          WHEN (SELECT ts FROM target_win) IS NOT NULL AND (
                 ((il.weekday_availability -> (SELECT key3 FROM wk) ->> 'from') IS NOT NULL
                    AND (SELECT ts FROM target_win) < (il.weekday_availability -> (SELECT key3 FROM wk) ->> 'from')::time)
              OR ((il.weekday_availability -> (SELECT key3 FROM wk) ->> 'until') IS NOT NULL
                    AND COALESCE((SELECT te FROM target_win), (SELECT ts FROM target_win)) > (il.weekday_availability -> (SELECT key3 FROM wk) ->> 'until')::time)
               ) THEN 'time'
          ELSE 'match'
        END
      )
      WHEN p_parent_type = 'camp' THEN (
        CASE
          WHEN ic.session_types IS NULL THEN 'none'
          WHEN (SELECT target_session_type FROM tgt) IS NULL THEN 'match'
          WHEN (SELECT target_session_type FROM tgt) = ANY(ic.session_types)
            OR ('full_day' = ANY(ic.session_types)
                 AND (SELECT target_session_type FROM tgt) IN ('morning', 'afternoon')) THEN 'match'
          ELSE 'time'
        END
      )
      ELSE 'none'
    END AS day_time_match,
    (
      p_parent_type = 'program'
      AND (SELECT target_district FROM tgt) IS NOT NULL
      AND jsonb_array_length(COALESCE(i.site_preferences -> 'districts', '[]'::jsonb)) > 0
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(i.site_preferences -> 'districts') dd
        WHERE lower(trim(dd)) = (SELECT target_district FROM tgt)
      )
    ) AS out_of_area,
    (t.instructor_id IS NOT NULL AND w.instructor_id IS NULL) AS tight_gap
  FROM instructors i
  LEFT JOIN working w      ON w.instructor_id = i.id
  LEFT JOIN tight t        ON t.instructor_id = i.id
  LEFT JOIN off_dates o    ON o.instructor_id = i.id
  LEFT JOIN ita_latest il  ON il.instructor_id = i.id
  LEFT JOIN ia_latest ic   ON ic.instructor_id = i.id
  WHERE i.organization_id = p_org
    AND i.is_active IS DISTINCT FROM false;
$function$;

-- ------------------------------------- the sub's portal card, that day's time --
-- start_time / end_time on a PROGRAM sub are now the class's times ON THE SUB
-- DATE (early release included), because the only thing a sub card or sub
-- detail page does with them is tell the sub when to turn up that one day.
-- early_release says why the time differs from the class's usual one. Camps
-- unchanged.
create or replace function public.get_my_sub_details()
returns table(substitution_id uuid, parent_assignment_type text, parent_assignment_id uuid,
              covered_instructor_id uuid, session jsonb, location jsonb)
language sql
stable security definer
set search_path to 'public'
as $function$
  with me as (select id from instructors where auth_user_id = auth.uid() limit 1)
  select s.id, 'camp', s.parent_assignment_id, ca.instructor_id,
    jsonb_build_object('id',cs.id,'curriculum_id',cs.curriculum_id,'curriculum_name',cs.curriculum_name,
      'location_name',cs.location_name,'location_id',cs.location_id,'starts_on',cs.starts_on,'ends_on',cs.ends_on,
      'start_time',cs.start_time,'end_time',cs.end_time,'week_num',cs.week_num,'current_enrollment',cs.current_enrollment),
    case when pl.id is not null then jsonb_build_object('name',pl.name,'address',pl.address,'contact_phone',pl.contact_phone,
      'room_number',pl.room_number,'arrival_instructions',pl.arrival_instructions,'dismissal_instructions',pl.dismissal_instructions) else null end
  from assignment_substitutions s
  join me on me.id = s.sub_instructor_id
  join camp_assignments ca on ca.id = s.parent_assignment_id and s.parent_assignment_type='camp'
  join camp_sessions cs on cs.id = ca.camp_session_id
  left join program_locations pl on pl.id = cs.location_id
  where s.status in ('pending','confirmed','taught','declined') and ca.published_at is not null
  union all
  select s.id, 'program', s.parent_assignment_id, pa.instructor_id,
    jsonb_build_object('id',pr.id,'curriculum',pr.curriculum,'curriculum_id',pr.curriculum_id,'day_of_week',pr.day_of_week,
      'start_time',t.start_time,'end_time',t.end_time,'early_release',t.early_release,
      'session_count',pr.session_count,'program_location_id',pr.program_location_id,
      'room',pr.room),
    case when pl.id is not null then jsonb_build_object('name',pl.name,'address',pl.address,'contact_phone',pl.contact_phone,
      'room_number',pl.room_number,'arrival_instructions',pl.arrival_instructions,'dismissal_instructions',pl.dismissal_instructions) else null end
  from assignment_substitutions s
  join me on me.id = s.sub_instructor_id
  join program_assignments pa on pa.id = s.parent_assignment_id and s.parent_assignment_type='program'
  join programs pr on pr.id = pa.program_id
  cross join lateral program_session_times_on(pr.id, s.date) t
  left join program_locations pl on pl.id = pr.program_location_id
  where s.status in ('pending','confirmed','taught','declined') and pa.published_at is not null;
$function$;

revoke execute on function public.get_my_sub_details() from public;
revoke execute on function public.get_my_sub_details() from anon;
grant  execute on function public.get_my_sub_details() to authenticated;
