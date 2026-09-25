-- A camp is a program whose sessions run on consecutive days.
--
-- Until now "camp" meant a row in camp_sessions, which is the SQUARESPACE-ERA
-- shape: camps were sold on Squarespace and imported, so that table has a cycle
-- instead of a term, a week number, a subject list limited to three values, no
-- draft state and no checkout - it never had to sell anything. Jessica,
-- 2026-09-25: "summer camp reg was run on Squarespace - we will never use that
-- structure again as everything will run through enrops."
--
-- So camps move to `programs`, and inherit what is already built and live:
-- the public catalog, checkout and the fee engine, rosters, payroll, refund
-- proration, the family emails, and instructor scheduling on the same board as
-- after-school. None of that has to be written again.
--
-- THE WHOLE DIFFERENCE between a class and a camp is one line, twice. Both
-- date-deriving functions walk forward from first_session_date with
--     v_candidate := v_first_date + (i * 7);
-- and nothing else in either is weekly. A camp advances ONE day at a time and
-- counts only the weekdays it actually meets.
--
-- WHY THIS IS SAFE FOR THE 102 LIVE PROGRAMS: class_days is NULL on every
-- existing row, and NULL takes the identical `i * 7` path, so their derived
-- dates are byte-identical. Verified before writing that nothing computes dates
-- for itself - all 47 call sites ask these functions, payroll's cron included
-- (derive_program_session_schedule), and src/lib/programSchedule.js says so in
-- its own header: "The one function that knows the truth".
--
-- session_count still means what it says: how many times the thing meets. A
-- Monday-to-Thursday camp is session_count 4 with four class_days, so the
-- existing loop bound needs no change at all - only the step and a weekday test.

alter table public.programs
  add column if not exists class_days text[];

comment on column public.programs.class_days is
  'NULL for a weekly class - sessions step forward 7 days from first_session_date, the original behaviour. Set (lowercase day names, e.g. {monday,tuesday,wednesday,thursday}) for a CAMP: sessions advance one day at a time and only the listed weekdays count, so a camp is a program that runs on consecutive days. day_of_week still holds the FIRST day, the way a one-off workshop derives its day from its date.';

-- Lowercase day names, matching camp_sessions.class_days and what every reader
-- already lowercases before comparing. A CHECK rather than a convention, because
-- this column decides which days a family is charged for and an instructor is
-- paid for.
alter table public.programs
  drop constraint if exists programs_class_days_valid;
alter table public.programs
  add constraint programs_class_days_valid
  check (
    class_days is null
    or (
      array_length(class_days, 1) between 1 and 7
      and class_days <@ array['monday','tuesday','wednesday','thursday','friday','saturday','sunday']::text[]
    )
  );
