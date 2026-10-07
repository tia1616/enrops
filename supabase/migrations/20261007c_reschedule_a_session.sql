-- Reschedule a session: take ONE date off ONE class, with or without a make-up.
--
-- WHY. Until now the only way to take a class day off was a SITE closure
-- (program_locations.closure_dates): it applies to every class at that school,
-- always adds a make-up week, has no undo, records no reason, and tells nobody.
-- The 9/29 Westridge day left three live sub offers behind it. Jessica's spec,
-- 2026-10-07: the operator picks the day, chooses yes/no on a make-up, can put
-- the day back, and payroll shows the day was not taught. Never the word
-- "cancel" in anything a person reads.
--
-- HOW. One new source the schedule reads, and nothing else changes shape:
--   makeup = true   behaves exactly like a closure: the date is skipped and the
--                   walk carries on, so the class gains a week at the end.
--   makeup = false  the date still USES its slot (session_count is what the
--                   family bought) but is not returned, so the class ends on
--                   its original last day with one fewer meeting.
-- Both derive functions read it, so every reader of the schedule moves with it:
-- parent dashboard, instructor portal, session reminders, refund proration,
-- payroll's is_final_session, session-confirmation-cron, the sub-coverage board
-- (program_meets_on) and the nightly sub-offer sweep.
--
-- CLASSES ONLY. A camp (class_days set) is a dated block and has no make-up
-- concept; the RPC refuses it.
--
-- PAY. A pay line is seeded only for a day derive calls a session, so a day
-- taken off BEFORE it arrives never gets one. A day taken off after today's
-- placeholder was seeded: that placeholder (confirmed_by 'pending', pay_status
-- 'pending', unpaid) is withheld with the reason below and restored on undo. A
-- day somebody confirmed as taught, or that has moved money, is refused: that
-- is a payroll correction, not a schedule change.

-- ------------------------------------------------------------------ store --
create table if not exists public.program_session_skips (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  program_id              uuid not null references public.programs(id) on delete cascade,
  session_date            date not null,
  makeup                  boolean not null,
  -- Chunk 4 (credits). Only meaningful without a make-up: with one, nothing
  -- was lost. Stored now so the row that records the decision carries it.
  credit_families         boolean not null default false,
  voided_confirmation_ids uuid[] not null default '{}',
  created_by              uuid,
  created_at              timestamptz not null default now(),
  restored_at             timestamptz,
  restored_by             uuid,
  constraint program_session_skips_credit_needs_lost_day
    check (not (makeup and credit_families))
);

create unique index if not exists program_session_skips_one_live_per_day
  on public.program_session_skips (program_id, session_date)
  where restored_at is null;

create index if not exists program_session_skips_org
  on public.program_session_skips (organization_id, session_date);

comment on table public.program_session_skips is
  'One class date taken off one program by the operator ("Reschedule a session"). '
  'Live while restored_at is null. makeup=true behaves like a closure (class gains a '
  'week); makeup=false keeps the slot (class ends on time, one fewer meeting). Read by '
  'derive_program_session_dates / _schedule via program_skipped_dates(). Written only '
  'by skip_program_session / restore_program_session.';

alter table public.program_session_skips enable row level security;

drop policy if exists program_session_skips_org_read on public.program_session_skips;
create policy program_session_skips_org_read on public.program_session_skips
  for select using (is_org_member(organization_id) or is_platform_admin());

revoke all on public.program_session_skips from anon;
revoke insert, update, delete on public.program_session_skips from authenticated;
grant select on public.program_session_skips to authenticated;

-- ------------------------------------------- what the schedule may read --
-- derive is SECURITY INVOKER and is called by parents, instructors and anon.
-- None of them can read the table (and should not see who did it or whether
-- families were credited), so the schedule reads only date + make-up through
-- this definer function. That is exactly what the schedule itself shows.
create or replace function public.program_skipped_dates(p_program_id uuid)
returns table(session_date date, makeup boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.session_date, s.makeup
    from program_session_skips s
   where s.program_id = p_program_id
     and s.restored_at is null;
$$;

revoke all on function public.program_skipped_dates(uuid) from public;
grant execute on function public.program_skipped_dates(uuid) to anon, authenticated, service_role;

-- ------------------------------------------------------ the date walk --
-- Unchanged from 20260925h except the four marked SKIP lines.
create or replace function public.derive_program_session_dates(p_program_id uuid)
returns date[]
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_first_date    DATE;
  v_count         INTEGER;
  v_end_date      DATE;
  v_location_id   UUID;
  v_org_id        UUID;
  v_term          TEXT;
  v_weekday       INTEGER;
  v_er_start      TEXT;
  v_class_days    TEXT[];
  v_consecutive   BOOLEAN;
  v_location_closures DATE[];
  v_district_closures DATE[];
  v_early_release_exceptions DATE[];
  v_all_closures  DATE[];
  v_skip_makeup   DATE[] := '{}';
  v_skip_lost     DATE[] := '{}';
  v_result        DATE[] := '{}';
  v_candidate     DATE;
  v_max_lookups   INTEGER;
  v_added         INTEGER := 0;
  i               INTEGER := 0;
BEGIN
  SELECT p.first_session_date, p.session_count, p.end_date, p.program_location_id,
         p.organization_id, p.term, p.early_release_start_time, p.class_days
  INTO v_first_date, v_count, v_end_date, v_location_id, v_org_id, v_term, v_er_start, v_class_days
  FROM programs p WHERE p.id = p_program_id;

  IF v_first_date IS NULL OR v_count IS NULL OR v_count <= 0 THEN
    RETURN '{}';
  END IF;

  v_consecutive := v_class_days IS NOT NULL AND array_length(v_class_days, 1) > 0;

  -- The SITE's own closures apply to everything. An unavailable building is an
  -- unavailable building whether a class or a camp was going to use it.
  SELECT COALESCE(pl.closure_dates, '{}')
  INTO v_location_closures
  FROM program_locations pl WHERE pl.id = v_location_id;

  v_weekday := EXTRACT(DOW FROM v_first_date);

  IF v_consecutive THEN
    -- A CAMP IGNORES THE DISTRICT CALENDAR. School being out is why the camp
    -- runs. Early release is a district fact about an after-school class's start
    -- time and is meaningless to a camp, so it goes with it.
    v_district_closures := '{}';
    v_early_release_exceptions := '{}';
  ELSE
    v_district_closures := resolve_district_closures(v_org_id, v_location_id, v_term);

    IF COALESCE(btrim(v_er_start), '') = '' THEN
      v_early_release_exceptions := resolve_district_early_release_exceptions(v_org_id, v_location_id, v_term, v_weekday);
    ELSE
      v_early_release_exceptions := '{}';
    END IF;

    -- SKIP: the operator's own days off this class. Classes only.
    SELECT COALESCE(array_agg(s.session_date) FILTER (WHERE s.makeup), '{}'),
           COALESCE(array_agg(s.session_date) FILTER (WHERE NOT s.makeup), '{}')
      INTO v_skip_makeup, v_skip_lost
      FROM program_skipped_dates(p_program_id) s;
  END IF;

  -- SKIP: a make-up skip is a closure for the walk - the class gains a week.
  v_all_closures := v_location_closures || v_district_closures || v_early_release_exceptions || v_skip_makeup;

  -- The two walks are bounded by different things, so they are SIZED by
  -- different things. A weekly class is bounded by its session count and a
  -- closure pushes the last session out, so it needs count * 2 plus room for
  -- every closure. A camp is bounded by end_date, so the exact number of steps
  -- is the span in days - closures cannot extend it.
  v_max_lookups := CASE
    WHEN v_consecutive THEN COALESCE(v_end_date - v_first_date, -1) + 1
    ELSE v_count * 2 + COALESCE(array_length(v_all_closures, 1), 0)
  END;

  -- A CAMP STOPS AT ITS LAST DAY. A weekly class carries a closed session
  -- forward - an 8-session term really does run nine weeks when a week is shut -
  -- but a camp is a block families booked by its dates, so a closed day is LOST,
  -- not made up in the following week.
  WHILE i < v_max_lookups LOOP
    v_candidate := CASE WHEN v_consecutive THEN v_first_date + i ELSE v_first_date + (i * 7) END;
    EXIT WHEN v_consecutive AND v_end_date IS NOT NULL AND v_candidate > v_end_date;
    EXIT WHEN NOT v_consecutive AND v_added >= v_count;
    IF v_consecutive AND NOT ((ARRAY['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])[EXTRACT(DOW FROM v_candidate)::int + 1] = ANY(v_class_days)) THEN
      i := i + 1;
      CONTINUE;
    END IF;
    IF NOT (v_candidate = ANY(v_all_closures)) THEN
      -- SKIP: a day taken off WITHOUT a make-up still uses its slot, so the
      -- class ends on its original last day, one meeting short.
      IF NOT (v_candidate = ANY(v_skip_lost)) THEN
        v_result := v_result || v_candidate;
      END IF;
      v_added := v_added + 1;
    END IF;
    i := i + 1;
  END LOOP;

  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------- the schedule walk --
-- Unchanged from the live definition except the marked SKIP lines. A skipped
-- day is emitted as kind 'no_school' (every reader already handles that kind:
-- sessions are kind = 'session'), reason 'Rescheduled' when a make-up was added
-- and 'No class' when it was not.
create or replace function public.derive_program_session_schedule(p_program_id uuid)
returns table(entry_date date, kind text, reason text, session_time text, session_end_time text)
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_first_date        DATE;
  v_count             INTEGER;
  v_end_date          DATE;
  v_location_id       UUID;
  v_org_id            UUID;
  v_term              TEXT;
  v_weekday           INTEGER;
  v_start_time        TEXT;
  v_end_time          TEXT;
  v_er_start          TEXT;
  v_er_end            TEXT;
  v_opted_in          BOOLEAN;
  v_class_days        TEXT[];
  v_consecutive       BOOLEAN;
  v_location_closures DATE[];
  v_district_closures DATE[];
  v_er_exceptions_all DATE[];
  v_early_release_exceptions DATE[];
  v_all_closures      DATE[];
  v_skip_makeup       DATE[] := '{}';
  v_skip_lost         DATE[] := '{}';
  v_district_reasons  JSONB := '{}'::jsonb;
  v_early_release_reasons JSONB := '{}'::jsonb;
  v_candidate         DATE;
  v_max_lookups       INTEGER;
  v_added             INTEGER := 0;
  i                   INTEGER := 0;
BEGIN
  SELECT p.first_session_date, p.session_count, p.end_date, p.program_location_id,
         p.organization_id, p.term, p.start_time, p.end_time,
         p.early_release_start_time, p.early_release_end_time, p.class_days
  INTO v_first_date, v_count, v_end_date, v_location_id, v_org_id, v_term, v_start_time, v_end_time,
       v_er_start, v_er_end, v_class_days
  FROM programs p WHERE p.id = p_program_id;

  IF v_first_date IS NULL OR v_count IS NULL OR v_count <= 0 THEN
    RETURN;
  END IF;

  v_consecutive := v_class_days IS NOT NULL AND array_length(v_class_days, 1) > 0;
  v_opted_in := COALESCE(btrim(v_er_start), '') <> '';

  SELECT COALESCE(pl.closure_dates, '{}')
  INTO v_location_closures
  FROM program_locations pl WHERE pl.id = v_location_id;

  v_weekday := EXTRACT(DOW FROM v_first_date);

  IF v_consecutive THEN
    -- A CAMP IGNORES THE DISTRICT CALENDAR. v_er_exceptions_all is emptied too,
    -- not just the closure set: it is what the early-release TIME branch below
    -- tests, so emptying it is what stops a camp's sessions being re-timed to an
    -- after-school early-release start.
    v_district_closures := '{}';
    v_er_exceptions_all := '{}';
    v_early_release_exceptions := '{}';
  ELSE
    v_district_closures := resolve_district_closures(v_org_id, v_location_id, v_term);
    v_er_exceptions_all := resolve_district_early_release_exceptions(v_org_id, v_location_id, v_term, v_weekday);
    v_early_release_exceptions := CASE WHEN v_opted_in THEN '{}'::date[] ELSE v_er_exceptions_all END;

    -- SKIP: the operator's own days off this class. Classes only.
    SELECT COALESCE(array_agg(s.session_date) FILTER (WHERE s.makeup), '{}'),
           COALESCE(array_agg(s.session_date) FILTER (WHERE NOT s.makeup), '{}')
      INTO v_skip_makeup, v_skip_lost
      FROM program_skipped_dates(p_program_id) s;
  END IF;

  -- SKIP: a make-up skip is a closure for the walk - the class gains a week.
  v_all_closures := v_location_closures || v_district_closures || v_early_release_exceptions || v_skip_makeup;

  -- The reason maps stay keyed off the district calendar for a class. A camp
  -- has no district closures left in v_all_closures, so nothing can look one
  -- up: a camp's only closed days are site closures, which fall through to
  -- 'No class' exactly as a class's site closures already do.
  SELECT COALESCE(jsonb_object_agg(d, r), '{}'::jsonb)
  INTO v_district_reasons
  FROM (
    SELECT DISTINCT ON (elem->>'date')
      elem->>'date' AS d,
      COALESCE(NULLIF(TRIM(elem->>'reason'), ''), 'No school') AS r
    FROM matching_district_calendars(v_org_id, v_location_id, v_term) dc
    CROSS JOIN LATERAL jsonb_array_elements(dc.no_school_dates) AS elem
    WHERE elem->>'date' IS NOT NULL
    ORDER BY elem->>'date', (NULLIF(TRIM(elem->>'reason'), '')) NULLS LAST
  ) x;

  SELECT COALESCE(jsonb_object_agg(d, r), '{}'::jsonb)
  INTO v_early_release_reasons
  FROM (
    SELECT DISTINCT ON (elem->>'date')
      elem->>'date' AS d,
      COALESCE(NULLIF(TRIM(elem->>'reason'), ''), 'Early release') AS r
    FROM matching_district_calendars(v_org_id, v_location_id, v_term) dc
    CROSS JOIN LATERAL jsonb_array_elements(dc.early_release_dates) AS elem
    WHERE elem->>'date' IS NOT NULL
    ORDER BY elem->>'date', (NULLIF(TRIM(elem->>'reason'), '')) NULLS LAST
  ) x;

  -- Same sizing rule as derive_program_session_dates, and it has to be in BOTH:
  -- an earlier bound fix went into that function only and left this one - the
  -- one PAYROLL reads - still carrying the defect. Span for a camp, count for a
  -- class.
  v_max_lookups := CASE
    WHEN v_consecutive THEN COALESCE(v_end_date - v_first_date, -1) + 1
    ELSE v_count * 2 + COALESCE(array_length(v_all_closures, 1), 0)
  END;

  WHILE i < v_max_lookups LOOP
    v_candidate := CASE WHEN v_consecutive THEN v_first_date + i ELSE v_first_date + (i * 7) END;
    EXIT WHEN v_consecutive AND v_end_date IS NOT NULL AND v_candidate > v_end_date;
    EXIT WHEN NOT v_consecutive AND v_added >= v_count;
    IF v_consecutive AND NOT ((ARRAY['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])[EXTRACT(DOW FROM v_candidate)::int + 1] = ANY(v_class_days)) THEN
      i := i + 1;
      CONTINUE;
    END IF;
    IF NOT (v_candidate = ANY(v_all_closures)) AND v_candidate = ANY(v_skip_lost) THEN
      -- SKIP: no make-up. The day uses its slot but nobody meets.
      entry_date := v_candidate;
      kind := 'no_school';
      reason := 'No class';
      session_time := NULL;
      session_end_time := NULL;
      RETURN NEXT;
      v_added := v_added + 1;
    ELSIF NOT (v_candidate = ANY(v_all_closures)) THEN
      entry_date := v_candidate;
      kind := 'session';
      IF v_opted_in AND v_candidate = ANY(v_er_exceptions_all) THEN
        reason := 'Early release';
        session_time := v_er_start;
        session_end_time := NULLIF(btrim(COALESCE(v_er_end, '')), '');
      ELSE
        reason := NULL;
        session_time := v_start_time;
        session_end_time := v_end_time;
      END IF;
      RETURN NEXT;
      v_added := v_added + 1;
    ELSIF v_candidate = ANY(v_all_closures) THEN
      entry_date := v_candidate;
      kind := 'no_school';
      reason := COALESCE(
        v_district_reasons ->> to_char(v_candidate, 'YYYY-MM-DD'),
        v_early_release_reasons ->> to_char(v_candidate, 'YYYY-MM-DD'),
        -- SKIP: the operator moved this one; a plain site closure stays 'No class'.
        CASE WHEN v_candidate = ANY(v_skip_makeup) THEN 'Rescheduled' END,
        'No class'
      );
      session_time := NULL;
      session_end_time := NULL;
      RETURN NEXT;
    END IF;
    i := i + 1;
  END LOOP;

  RETURN;
END;
$function$;

-- ---------------------------------------------------------- take a day off --
create or replace function public.skip_program_session(p_program_id uuid, p_date date, p_makeup boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
DECLARE
  v_org        uuid;
  v_class_days text[];
  v_skip_id    uuid;
  v_voided     uuid[] := '{}';
  v_blocking   int;
  v_covers     jsonb;
  v_dates      date[];
BEGIN
  IF p_program_id IS NULL OR p_date IS NULL OR p_makeup IS NULL THEN
    RAISE EXCEPTION 'program, date and make-up choice are all required';
  END IF;

  SELECT p.organization_id, p.class_days INTO v_org, v_class_days
    FROM programs p WHERE p.id = p_program_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'program not found';
  END IF;
  IF NOT (can_admin_org(v_org) OR is_platform_admin()) THEN
    RAISE EXCEPTION 'not authorized to change this program''s schedule';
  END IF;
  IF v_class_days IS NOT NULL AND array_length(v_class_days, 1) > 0 THEN
    RAISE EXCEPTION 'camp days cannot be rescheduled one at a time';
  END IF;

  -- One schedule change per class at a time: two operators taking two days off
  -- at once would each check the schedule before the other's row existed.
  PERFORM pg_advisory_xact_lock(hashtext('program_schedule:' || p_program_id::text));

  IF NOT (p_date = ANY (derive_program_session_dates(p_program_id))) THEN
    RAISE EXCEPTION 'that date is not a class day for this class';
  END IF;

  -- A day somebody said they taught, or that has moved money, is not a
  -- schedule change any more. Only the untouched cron placeholder may go.
  SELECT count(*) INTO v_blocking
    FROM session_delivery_confirmations c
   WHERE c.program_id = p_program_id
     AND c.session_date = p_date
     AND (c.confirmed_by <> 'pending' OR c.pay_status <> 'pending' OR c.instructor_payout_id IS NOT NULL);
  IF v_blocking > 0 THEN
    RAISE EXCEPTION 'that class was already marked taught or paid, so it can''t be rescheduled - correct it in payroll instead';
  END IF;

  WITH v AS (
    UPDATE session_delivery_confirmations c
       SET pay_status = 'withheld',
           pay_adjustment_reason = 'No class (rescheduled)',
           updated_at = now()
     WHERE c.program_id = p_program_id
       AND c.session_date = p_date
       AND c.confirmed_by = 'pending'
       AND c.pay_status = 'pending'
       AND c.instructor_payout_id IS NULL
     RETURNING c.id
  )
  SELECT COALESCE(array_agg(id), '{}') INTO v_voided FROM v;

  INSERT INTO program_session_skips
    (organization_id, program_id, session_date, makeup, voided_confirmation_ids, created_by)
  VALUES (v_org, p_program_id, p_date, p_makeup, v_voided, auth.uid())
  RETURNING id INTO v_skip_id;

  -- Anyone who ACCEPTED a sub day on this date. The pop-up releases them
  -- through cancel-sub-cover so they are told; the schedule change alone
  -- must not silently drop a person who said yes.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'substitution_id', s.id,
           'sub_instructor_id', s.sub_instructor_id,
           'name', nullif(trim(coalesce(nullif(i.preferred_name, ''), i.first_name, '') || ' ' || coalesce(i.last_name, '')), '')
         )), '[]'::jsonb)
    INTO v_covers
    FROM assignment_substitutions s
    JOIN program_assignments pa ON pa.id = s.parent_assignment_id AND s.parent_assignment_type = 'program'
    LEFT JOIN instructors i ON i.id = s.sub_instructor_id
   WHERE pa.program_id = p_program_id
     AND s.date = p_date
     AND s.status = 'confirmed';

  v_dates := derive_program_session_dates(p_program_id);

  RETURN jsonb_build_object(
    'skip_id', v_skip_id,
    'date', p_date,
    'makeup', p_makeup,
    'last_date', (SELECT max(d) FROM unnest(v_dates) d),
    'sessions_left_in_schedule', COALESCE(array_length(v_dates, 1), 0),
    'voided_pay_lines', COALESCE(array_length(v_voided, 1), 0),
    'confirmed_covers', v_covers
  );
END;
$$;

-- ------------------------------------------------------- put a day back --
create or replace function public.restore_program_session(p_skip_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
DECLARE
  v_row    program_session_skips%ROWTYPE;
  v_dates  date[];
BEGIN
  SELECT * INTO v_row FROM program_session_skips WHERE id = p_skip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that rescheduled day was not found';
  END IF;
  IF NOT (can_admin_org(v_row.organization_id) OR is_platform_admin()) THEN
    RAISE EXCEPTION 'not authorized to change this program''s schedule';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('program_schedule:' || v_row.program_id::text));

  -- Re-read under the lock: two undos at once must not both proceed.
  SELECT * INTO v_row FROM program_session_skips WHERE id = p_skip_id FOR UPDATE;
  IF v_row.restored_at IS NOT NULL THEN
    RAISE EXCEPTION 'that day is already back on the schedule';
  END IF;

  UPDATE program_session_skips
     SET restored_at = now(), restored_by = auth.uid()
   WHERE id = p_skip_id;

  -- Only the placeholders THIS skip withheld, and only while they still carry
  -- its reason: an admin who has since decided something else about that line
  -- keeps their decision.
  UPDATE session_delivery_confirmations c
     SET pay_status = 'pending',
         pay_adjustment_reason = NULL,
         updated_at = now()
   WHERE c.id = ANY (v_row.voided_confirmation_ids)
     AND c.pay_status = 'withheld'
     AND c.pay_adjustment_reason = 'No class (rescheduled)'
     AND c.instructor_payout_id IS NULL;

  v_dates := derive_program_session_dates(v_row.program_id);

  RETURN jsonb_build_object(
    'date', v_row.session_date,
    'makeup', v_row.makeup,
    'last_date', (SELECT max(d) FROM unnest(v_dates) d),
    'back_on_schedule', v_row.session_date = ANY (v_dates)
  );
END;
$$;

revoke all on function public.skip_program_session(uuid, date, boolean) from public, anon;
grant execute on function public.skip_program_session(uuid, date, boolean) to authenticated, service_role;
revoke all on function public.restore_program_session(uuid) from public, anon;
grant execute on function public.restore_program_session(uuid) to authenticated, service_role;
