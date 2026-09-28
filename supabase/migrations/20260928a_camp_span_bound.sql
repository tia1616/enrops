-- A camp's span is bounded, so a typo cannot turn every date read into a
-- decade-long walk.
--
-- Code-review finding, 2026-09-28. Since 20260925f the consecutive walk is sized
-- by its date span:
--     v_max_lookups := (end_date - first_session_date) + 1
-- which is exact and is what fixed the ten-day camp truncating to five. But
-- nothing bounds how far end_date can sit from first_session_date, and
-- programs_class_days_need_end_date only requires end_date to be NOT NULL, not
-- to be sane. An operator typing 2207 instead of 2027 creates a camp whose every
-- call to derive_program_session_dates and derive_program_session_schedule
-- iterates ~66,000 times and returns tens of thousands of dates. Those two are
-- STABLE functions called PER ROW by the public catalog, rosters, payroll and
-- refund proration, so one typo degrades reads well beyond that one camp.
--
-- FIXED IN THE DATA, NOT THE LOOP. The obvious alternative - cap v_max_lookups -
-- reintroduces exactly the bug this branch just spent two commits removing: a
-- capped walk silently returns a SHORT camp, and a short camp underpays an
-- instructor and misprorates a refund. A CHECK cannot be satisfied quietly; the
-- operator gets an error at the moment they typed the wrong year, which is the
-- only moment they can fix it.
--
-- 366 days rather than a tighter number because the column is the platform's,
-- not J2S's: a camp is normally a week, but nothing about the shape forbids a
-- provider running a year-long consecutive-day programme, and this constraint is
-- a runaway guard, not a product rule about how long a camp should be. A whole
-- year of daily sessions still walks a bounded, sane number of days.
--
-- Weekly classes are untouched: the CHECK only applies when class_days is set,
-- and a weekly program's end_date is free to sit wherever it does today. Verified
-- before adding: 0 rows on either database have class_days set, so nothing can
-- fail this on the way in.

alter table public.programs
  drop constraint if exists programs_camp_span_bounded;
alter table public.programs
  add constraint programs_camp_span_bounded
  check (
    class_days is null
    or end_date is null
    or first_session_date is null
    or (end_date - first_session_date) between 0 and 366
  );

comment on constraint programs_camp_span_bounded on public.programs is
  'A camp (class_days set) runs on consecutive days, and its date walk is sized by end_date - first_session_date. This bounds that span so a mistyped year cannot make every derive_program_session_dates call walk decades - those functions run per row on the public catalog, rosters, payroll and refund proration. 366 days is a runaway guard, not a product rule: it exists to make the typo loud, because the alternative (silently capping the walk) returns a short camp, which underpays instructors and misprorates refunds.';
