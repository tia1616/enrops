-- Does a sub check read the SCHEDULE for the sub date? (20261021a)
--
-- Run against STAGING (mumfymlapolsfdnpewci). It builds its own fixture inside
-- the QA org, asserts, and then RAISES on purpose so the whole thing rolls back:
-- nothing is left behind. The result is the error text:
--   PROBE_OK  n checks passed            - every assertion held
--   PROBE_FAIL <what>                    - the first assertion that did not
-- Do not run it on prod: it writes (even though it rolls back) and prod has no
-- QA org.
--
-- THE TWO BUGS IT PINS, both from a real refused sub on 2026-10-21:
--   1. A class whose school is CLOSED that day (no-school date on its district
--      calendar) counted as a commitment, so a sub was refused for a class that
--      was not meeting.
--   2. The sub slot used the class's usual time on an EARLY-RELEASE day, when
--      the class runs at its early-release times.
-- And the reverse of 2, which the old code missed in the other direction: a
-- class of the sub's own at NOON does clash with an 11:55-12:40 early-release
-- slot, and must be refused.
--
-- Date D = Wednesday 2026-10-28. All classes are Wednesdays from 2026-10-07.
--   X  early-release site   2:35-3:20 PM, early release 11:55 AM-12:40 PM   (the class needing a sub)
--   Y  closed site          3:10-3:55 PM   taught by S1  (Jeremiah's St. Clare)
--   Z  plain site          12:00-12:30 PM  taught by S2  (clashes with the ER slot)
--   W  plain site           2:30-3:30 PM   taught by S3  (clashed with X's USUAL time only)

do $probe$
declare
  v_org  uuid := 'b177a0ea-32c6-45c9-82ac-cbb7261c2dee';  -- Cascade Enrichment Co. (QA fixture org)
  v_admin uuid := '9d73c379-79ff-469a-a1c4-ba44da9205c5'; -- its org ADMIN auth user
  d      date := '2026-10-28';
  tag    text := 'qa-subwin-' || substr(md5(clock_timestamp()::text), 1, 8);
  l_er uuid; l_ns uuid; l_plain uuid;
  i_reg uuid; i_s1 uuid; i_s2 uuid; i_s3 uuid;
  p_x uuid; p_y uuid; p_z uuid; p_w uuid;
  a_x uuid; a_y uuid; a_z uuid; a_w uuid;
  s1 uuid; s2 uuid; s3 uuid;
  v_ts time; v_te time; v_txt text; v_er boolean; v_n int; v_res jsonb;
  ok int := 0;
  r record;
begin
  -- ---------------------------------------------------------------- fixture --
  insert into program_locations(name, slug, organization_id, district)
    values (tag||' ER site', tag||'-er', v_org, tag||' ER district') returning id into l_er;
  insert into program_locations(name, slug, organization_id, district)
    values (tag||' closed site', tag||'-ns', v_org, tag||' NS district') returning id into l_ns;
  insert into program_locations(name, slug, organization_id, district)
    values (tag||' plain site', tag||'-pl', v_org, tag||' plain district') returning id into l_plain;

  insert into district_calendars(organization_id, district, school_year, first_day_of_school, last_day_of_school,
                                 no_school_dates, early_release_dates)
    values (v_org, tag||' ER district', term_to_school_year('FA26'), '2026-09-01', '2027-06-15',
            '[]'::jsonb, jsonb_build_array(jsonb_build_object('date', d::text, 'reason', 'Early release')));
  insert into district_calendars(organization_id, district, school_year, first_day_of_school, last_day_of_school,
                                 no_school_dates, early_release_dates)
    values (v_org, tag||' NS district', term_to_school_year('FA26'), '2026-09-01', '2027-06-15',
            jsonb_build_array(jsonb_build_object('date', d::text, 'reason', 'No School - Parent Teacher Conferences')),
            '[]'::jsonb);

  insert into instructors(organization_id, first_name, last_name, email)
    values (v_org, 'QA', 'Regular', tag||'-reg@staging.enrops.test') returning id into i_reg;
  insert into instructors(organization_id, first_name, last_name, email)
    values (v_org, 'QA', 'SubClosed', tag||'-s1@staging.enrops.test') returning id into i_s1;
  insert into instructors(organization_id, first_name, last_name, email)
    values (v_org, 'QA', 'SubNoon', tag||'-s2@staging.enrops.test') returning id into i_s2;
  insert into instructors(organization_id, first_name, last_name, email)
    values (v_org, 'QA', 'SubAfternoon', tag||'-s3@staging.enrops.test') returning id into i_s3;

  insert into programs(organization_id, program_location_id, curriculum, day_of_week, price_cents, status, term,
                       first_session_date, session_count, start_time, end_time,
                       early_release_start_time, early_release_end_time)
    values (v_org, l_er, tag||' X', 'Wednesday', 1000, 'open', 'FA26', '2026-10-07', 8,
            '2:35 PM', '3:20 PM', '11:55 AM', '12:40 PM') returning id into p_x;
  insert into programs(organization_id, program_location_id, curriculum, day_of_week, price_cents, status, term,
                       first_session_date, session_count, start_time, end_time)
    values (v_org, l_ns, tag||' Y', 'Wednesday', 1000, 'open', 'FA26', '2026-10-07', 8, '3:10 PM', '3:55 PM')
    returning id into p_y;
  insert into programs(organization_id, program_location_id, curriculum, day_of_week, price_cents, status, term,
                       first_session_date, session_count, start_time, end_time)
    values (v_org, l_plain, tag||' Z', 'Wednesday', 1000, 'open', 'FA26', '2026-10-07', 8, '12:00 PM', '12:30 PM')
    returning id into p_z;
  insert into programs(organization_id, program_location_id, curriculum, day_of_week, price_cents, status, term,
                       first_session_date, session_count, start_time, end_time)
    values (v_org, l_plain, tag||' W', 'Wednesday', 1000, 'open', 'FA26', '2026-10-07', 8, '2:30 PM', '3:30 PM')
    returning id into p_w;

  insert into program_assignments(organization_id, program_id, instructor_id, role, status, published_at)
    values (v_org, p_x, i_reg, 'lead', 'confirmed', now()) returning id into a_x;
  insert into program_assignments(organization_id, program_id, instructor_id, role, status, published_at)
    values (v_org, p_y, i_s1, 'lead', 'confirmed', now()) returning id into a_y;
  insert into program_assignments(organization_id, program_id, instructor_id, role, status, published_at)
    values (v_org, p_z, i_s2, 'lead', 'confirmed', now()) returning id into a_z;
  insert into program_assignments(organization_id, program_id, instructor_id, role, status, published_at)
    values (v_org, p_w, i_s3, 'lead', 'confirmed', now()) returning id into a_w;

  insert into assignment_substitutions(organization_id, parent_assignment_id, parent_assignment_type, sub_instructor_id, date, sub_tier, status)
    values (v_org, a_x, 'program', i_s1, d, 'lead', 'pending') returning id into s1;
  insert into assignment_substitutions(organization_id, parent_assignment_id, parent_assignment_type, sub_instructor_id, date, sub_tier, status)
    values (v_org, a_x, 'program', i_s2, d, 'lead', 'pending') returning id into s2;
  insert into assignment_substitutions(organization_id, parent_assignment_id, parent_assignment_type, sub_instructor_id, date, sub_tier, status)
    values (v_org, a_x, 'program', i_s3, d, 'lead', 'pending') returning id into s3;

  -- The fixture really is what the probe claims: the SCHEDULE says these things.
  if not exists (select 1 from derive_program_session_schedule(p_y) x where x.entry_date = d and x.kind = 'no_school') then
    raise exception 'PROBE_FAIL fixture: Y is not a no_school day on %', d; end if;
  if not exists (select 1 from derive_program_session_schedule(p_x) x where x.entry_date = d and x.kind = 'session'
                  and x.reason = 'Early release' and x.session_time = '11:55 AM') then
    raise exception 'PROBE_FAIL fixture: X is not an early-release session on %', d; end if;
  ok := ok + 2;

  -- --------------------------------------------- program_session_times_on --
  select t.start_time, t.end_time, t.early_release into r from program_session_times_on(p_x, d) t;
  if r.start_time <> '11:55 AM' or r.end_time <> '12:40 PM' or r.early_release is not true then
    raise exception 'PROBE_FAIL times_on X on ER day: % - % (er=%)', r.start_time, r.end_time, r.early_release; end if;
  select t.start_time, t.end_time, t.early_release into r from program_session_times_on(p_x, d - 7) t;
  if r.start_time <> '2:35 PM' or r.end_time <> '3:20 PM' or r.early_release is not false then
    raise exception 'PROBE_FAIL times_on X on a normal day: % - % (er=%)', r.start_time, r.end_time, r.early_release; end if;
  ok := ok + 2;

  -- ------------------------------------------------------- sub_slot_window --
  select w.ts, w.te into v_ts, v_te from sub_slot_window('program', a_x, d) w;
  if v_ts <> '11:55' or v_te <> '12:40' then
    raise exception 'PROBE_FAIL bug 2: slot on ER day is % - %, want 11:55 - 12:40', v_ts, v_te; end if;
  select w.ts, w.te into v_ts, v_te from sub_slot_window('program', a_x, d - 7) w;
  if v_ts <> '14:35' or v_te <> '15:20' then
    raise exception 'PROBE_FAIL slot on a normal day is % - %, want 14:35 - 15:20', v_ts, v_te; end if;
  ok := ok + 2;

  -- ------------------------------------------- instructor_commitments_on_date --
  if exists (select 1 from instructor_commitments_on_date(i_s1, d) c where c.source = 'teaching') then
    raise exception 'PROBE_FAIL bug 1: a class on a no-school day still counts as teaching'; end if;
  if not exists (select 1 from instructor_commitments_on_date(i_s1, d - 7) c
                  where c.source = 'teaching' and c.ts = '15:10' and c.te = '15:55') then
    raise exception 'PROBE_FAIL control: the same class on a normal day is not a commitment'; end if;
  ok := ok + 2;

  -- A cancelled class is not a commitment either (same exclude list as the portal).
  update programs set status = 'cancelled' where id = p_z;
  if exists (select 1 from instructor_commitments_on_date(i_s2, d) c where c.source = 'teaching') then
    raise exception 'PROBE_FAIL a cancelled class still counts as teaching'; end if;
  update programs set status = 'open' where id = p_z;
  ok := ok + 1;

  -- ---------------------------------------------------------- the picker --
  -- As the org ADMIN under real RLS + grants (it is SECURITY INVOKER, and now
  -- calls two functions that used to be service_role-only).
  -- The role switch lives in a sub-block that always raises, so rolling the
  -- sub-block back is what restores the role: authenticated cannot SET ROLE
  -- its way back up.
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    v_txt := '';
    v_n := 0;
    for r in select a.instructor_id, a.is_working, a.working_reason
               from sub_availability_on_date(v_org, d, 'program', a_x) a
              where a.instructor_id in (i_s1, i_s2, i_s3) loop
      if r.instructor_id = i_s1 and r.is_working then
        v_txt := v_txt || ' closed-school sub shown as working (' || r.working_reason || ');'; end if;
      if r.instructor_id = i_s2 and not r.is_working then
        v_txt := v_txt || ' noon class does not clash with the early-release slot;'; end if;
      if r.instructor_id = i_s3 and r.is_working then
        v_txt := v_txt || ' afternoon class clashes with an early-release slot (' || r.working_reason || ');'; end if;
      v_n := v_n + 1;
    end loop;
    raise exception using errcode = 'QA002', message = v_n::text || '|' || v_txt;
  exception when sqlstate 'QA002' then
    v_n := split_part(sqlerrm, '|', 1)::int;
    v_txt := split_part(sqlerrm, '|', 2);
  end;
  if v_txt <> '' then raise exception 'PROBE_FAIL picker:%', v_txt; end if;
  -- A picker that returns nothing passes every check above. It must see all 3.
  if v_n <> 3 then raise exception 'PROBE_FAIL picker returned % of the 3 subs to an org admin', v_n; end if;
  ok := ok + 3;

  -- -------------------------------------------------------- accept_sub_offer --
  -- Each accept runs in its own sub-block and is undone, so one win does not
  -- close the others out.
  begin
    v_res := accept_sub_offer(s1, i_s1);
    raise exception using errcode = 'QA001', message = v_res::text;
  exception when sqlstate 'QA001' then v_txt := sqlerrm; end;
  if (v_txt::jsonb ->> 'outcome') <> 'won' then
    raise exception 'PROBE_FAIL bug 1 (Jeremiah): closed-school sub got %', v_txt; end if;

  begin
    v_res := accept_sub_offer(s2, i_s2);
    raise exception using errcode = 'QA001', message = v_res::text;
  exception when sqlstate 'QA001' then v_txt := sqlerrm; end;
  if (v_txt::jsonb ->> 'outcome') <> 'time_conflict' then
    raise exception 'PROBE_FAIL bug 2 reverse: noon class vs early-release slot got %', v_txt; end if;

  begin
    v_res := accept_sub_offer(s3, i_s3);
    raise exception using errcode = 'QA001', message = v_res::text;
  exception when sqlstate 'QA001' then v_txt := sqlerrm; end;
  if (v_txt::jsonb ->> 'outcome') <> 'won' then
    raise exception 'PROBE_FAIL bug 2: afternoon class vs early-release slot got %', v_txt; end if;
  ok := ok + 3;

  -- Once covered, the SUB's commitment is the early-release window too.
  update assignment_substitutions set status = 'confirmed' where id = s1;
  if not exists (select 1 from instructor_commitments_on_date(i_s1, d) c
                  where c.source = 'subbing' and c.ts = '11:55' and c.te = '12:40') then
    raise exception 'PROBE_FAIL a confirmed sub day is not held at the early-release window'; end if;
  ok := ok + 1;

  raise exception 'PROBE_OK % checks passed', ok;
end;
$probe$;
