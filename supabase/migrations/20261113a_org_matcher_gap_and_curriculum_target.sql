-- Two per-provider settings the after-school matcher reads (2026-11-13).
--
-- min_minutes_between_sites
--   Same day, DIFFERENT sites: the next class must start at least this many
--   minutes after the previous one ends. Same-site back-to-back is untouched
--   (one building, no drive). 0 turns the rule off.
--   The WI27 run put one instructor at Atfalati Ridge until 2:35 PM and at
--   Alameda Elementary from 2:35 PM, because the only same-day rule was "times
--   do not overlap" (20260818a), and touching times do not overlap.
--   HARD in match-afterschool (it writes with nobody looking); an OVERRIDABLE
--   block on the after-school board (the operator knows when two sites are
--   across the street). Deliberately NOT in check_program_assignment_conflict:
--   the trigger re-runs on every status change, so adding it there would start
--   refusing publish/confirm on pairs operators already placed by hand.
--
-- target_curricula_per_instructor
--   How many distinct class types (= material kits) one instructor should carry
--   in a term. The matcher prefers anyone who stays at or under it, and only
--   gives someone a kit past it when the alternative is leaving the class
--   unstaffed. A target, not a cap.
--
-- Additive, defaulted, inert until match-afterschool v-next reads them.
-- organizations has table-level grants (relacl), so no column grant is needed.

alter table public.organizations
  add column if not exists min_minutes_between_sites integer not null default 30,
  add column if not exists target_curricula_per_instructor integer not null default 3;

alter table public.organizations
  drop constraint if exists organizations_min_minutes_between_sites_check;
alter table public.organizations
  add constraint organizations_min_minutes_between_sites_check
    check (min_minutes_between_sites between 0 and 240);

alter table public.organizations
  drop constraint if exists organizations_target_curricula_per_instructor_check;
alter table public.organizations
  add constraint organizations_target_curricula_per_instructor_check
    check (target_curricula_per_instructor between 1 and 20);

comment on column public.organizations.min_minutes_between_sites is
  'Same-day classes at DIFFERENT sites need at least this many minutes between one ending and the next starting. 0 = off. Read by match-afterschool (hard) and the after-school board (overridable).';
comment on column public.organizations.target_curricula_per_instructor is
  'Distinct class types (material kits) per instructor per term the matcher aims to stay within; exceeded only to avoid leaving a class unstaffed.';
