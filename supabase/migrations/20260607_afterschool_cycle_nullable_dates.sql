-- After-school cycles are registration-driven: the term's dates, schools, curriculum,
-- and enrollment all come from the programs/registration, NOT a manually entered term
-- start/end. (Camps still need explicit dates to derive their Mon-Fri weeks.)
--
-- Make scheduling_cycles.starts_on / ends_on nullable so an after-school cycle can be
-- a dateless term marker, and keep camps honest with a CHECK that requires dates for
-- any non-after-school cycle. `weeks` stays NOT NULL (after-school inserts []).

alter table public.scheduling_cycles
  alter column starts_on drop not null,
  alter column ends_on drop not null;

alter table public.scheduling_cycles
  add constraint scheduling_cycles_nonafterschool_dates_check
    check (cycle_type = 'afterschool' or (starts_on is not null and ends_on is not null));
