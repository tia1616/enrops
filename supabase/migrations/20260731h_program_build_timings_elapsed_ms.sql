-- program_build_timings: measure elapsed time with ONE clock, and stop throwing
-- rows away when the operator's laptop disagrees with the server.
--
-- 20260731c shipped with:
--     check (completed_at >= started_at)
-- where started_at comes from the BROWSER (new Date().toISOString()) and
-- completed_at is the column's server-side now(). Those are two different clocks.
-- An operator whose machine runs two minutes fast finishes a 90-second build and
-- sends a started_at that is 30 seconds in the server's FUTURE - the constraint
-- rejects the insert, and the client only console.warns, so nothing surfaces.
-- Every build from that machine is lost permanently and invisibly, from the one
-- table whose entire purpose is collecting them. Worse than a gap: clock skew is
-- systematic per machine, so it would quietly bias the first-vs-repeat split too.
--
-- Fix: the client measures the DURATION itself, with a monotonic clock, and sends
-- that. A duration from one clock cannot disagree with anything. started_at stays
-- for context but is no longer load-bearing and is no longer constrained against
-- a timestamp it was never comparable to.
--
-- Read elapsed_ms, not (completed_at - started_at).
--
-- Migration is additive and the table is tiny; existing rows are backfilled from
-- the old difference, which is the best estimate available for them and is
-- correct wherever the clocks happened to agree.

alter table public.program_build_timings
  add column if not exists elapsed_ms integer;

-- Backfill before adding the guard, so existing rows can satisfy it.
update public.program_build_timings
set elapsed_ms = greatest(0, round(extract(epoch from (completed_at - started_at)) * 1000))::integer
where elapsed_ms is null;

alter table public.program_build_timings
  drop constraint if exists program_build_timings_finish_after_start;

-- Safe to constrain: this one is measured end-to-end on a single monotonic clock,
-- so a negative value would be a bug in our own code rather than a fact about
-- somebody's system settings.
alter table public.program_build_timings
  drop constraint if exists program_build_timings_elapsed_sane;
alter table public.program_build_timings
  add constraint program_build_timings_elapsed_sane
  check (elapsed_ms is null or elapsed_ms >= 0);

comment on column public.program_build_timings.elapsed_ms is
  'How long the build took, measured by the CLIENT across a single monotonic clock. Authoritative - read this, not (completed_at - started_at), which spans two machines'' clocks and can disagree.';
