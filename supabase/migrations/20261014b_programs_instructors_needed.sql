-- How many instructors a program needs, and the one place that answers it.
--
-- Until now every after-school class and program-camp was staffed by exactly one
-- lead: the board, the matcher and the home page all treated "has an active
-- assignment" as "staffed". Some classes need two adults (Tiny Coders at a few
-- parks-and-rec sites), and some camps need a second instructor once they fill.
--
--   instructors_needed                     the base count. Default 1, so every
--                                          existing program is unchanged.
--   second_instructor_after_registrations  optional. When enrollment goes PAST
--                                          this number (13th registration for 12),
--                                          the program needs at least 2. NULL = off.
--
-- Both slots are LEADS (Jessica, 2026-10-14): the second instructor is paid as a
-- lead, so no new role is introduced and program_assignments_role_check is untouched.
--
-- program_staffing is the ONLY place the effective count is computed. The board,
-- match-afterschool and the home page all read it, so the rule cannot drift
-- between them. "Registrations" is program_enrollment.enrolled (not cancelled,
-- paid or confirmed) - the number the board already shows - NOT seats_taken,
-- which also counts 40-minute checkout holds and waitlist offers and would open
-- and close a staffing slot inside the hour.
--
-- Additive only. No program_assignments row is read or written by this migration.

alter table public.programs
  add column if not exists instructors_needed integer not null default 1,
  add column if not exists second_instructor_after_registrations integer;

-- Drop-then-add so the whole file is safe to run twice (a parity sweep, or a
-- prod apply after a partial run). A bare ADD CONSTRAINT raised 42710 on the
-- second run and aborted before the view below was ever created.
alter table public.programs
  drop constraint if exists programs_instructors_needed_check,
  drop constraint if exists programs_second_instructor_after_registrations_check;
alter table public.programs
  add constraint programs_instructors_needed_check
    check (instructors_needed between 1 and 4),
  add constraint programs_second_instructor_after_registrations_check
    check (second_instructor_after_registrations is null or second_instructor_after_registrations >= 1);

comment on column public.programs.instructors_needed is
  'Base number of instructors this program needs (1-4). The effective count, including the enrollment trigger, comes from the program_staffing view - read that, never re-derive it.';
comment on column public.programs.second_instructor_after_registrations is
  'Optional. Once enrolled (program_enrollment.enrolled) is GREATER than this, the program needs at least 2 instructors. NULL = no trigger.';

create or replace view public.program_staffing
with (security_invoker = on) as
select
  p.id as program_id,
  p.organization_id,
  p.instructors_needed as base_instructors_needed,
  p.second_instructor_after_registrations,
  coalesce(pe.enrolled, 0) as enrolled,
  case
    when p.second_instructor_after_registrations is not null
     and coalesce(pe.enrolled, 0) > p.second_instructor_after_registrations
      then greatest(p.instructors_needed, 2)
    else p.instructors_needed
  end as instructors_needed
from public.programs p
left join public.program_enrollment pe on pe.program_id = p.id;

comment on view public.program_staffing is
  'Effective instructors needed per program right now: programs.instructors_needed, raised to 2 once enrollment passes second_instructor_after_registrations. The single source for the schedule board, match-afterschool and the home page.';

-- Staff-only surface. security_invoker means programs/registrations RLS still
-- applies to whoever reads it; anon has no business here at all.
revoke all on public.program_staffing from public, anon, authenticated;
grant select on public.program_staffing to authenticated, service_role;
