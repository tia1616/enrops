-- programs: stop inventing a grade range, and enforce that ranges run forwards.
--
-- WHY (2026-08-07). Two facts the app has been working around instead of fixing:
--
-- 1. grade_min DEFAULT 0, grade_max DEFAULT 5. Any insert that merely OMITS the
--    columns silently stamps the row "Grades K-5" - a school-year assumption
--    inherited from tenant 1 that a dance or music studio has no use for. The row
--    then cannot distinguish "this class is for K-5" from "nobody said". Three
--    separate writers now carry comments explaining that they must pass explicit
--    NULLs to avoid it; the defence is opt-in while the hazard is opt-out, so the
--    next importer, edge function or SQL fix-up inherits the bug by doing nothing.
--
-- 2. No range check, while the parallel `curricula` table has had
--    curricula_grade_range_valid and curricula_age_range_valid since it was
--    created. So "the first grade should be the lower one" is enforced only by
--    client-side guards in the two builders, and anything that writes programs
--    another way can store Grades 5-2. A backwards range reaches families: the
--    catalog card renders it verbatim.
--
-- SAFE ON EXISTING DATA. Dropping a DEFAULT changes nothing already stored and
-- only affects future inserts that omit the column. Verified before writing this:
-- zero rows on staging (113 programs) and zero on prod (104) violate either new
-- constraint, so both ADD CONSTRAINTs validate without touching a row.
--
-- DELIBERATELY NOT BACKFILLED. 54 staging rows and 36 prod rows currently hold
-- exactly 0/5. Some are genuine K-5 classes and some are the default nobody chose,
-- and the row does not record which - that is the ambiguity this migration stops
-- creating MORE of. Rewriting them would be guessing at real tenant data. They
-- keep their values; only new rows get honest NULLs.

alter table public.programs alter column grade_min drop default;
alter table public.programs alter column grade_max drop default;

-- Names mirror the curricula constraints exactly, so the two tables read the same
-- way to whoever meets them next.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.programs'::regclass and conname = 'programs_grade_range_valid'
  ) then
    alter table public.programs
      add constraint programs_grade_range_valid
      check (grade_min is null or grade_max is null or grade_min <= grade_max);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.programs'::regclass and conname = 'programs_age_range_valid'
  ) then
    alter table public.programs
      add constraint programs_age_range_valid
      check (age_min is null or age_max is null or age_min <= age_max);
  end if;
end $$;
