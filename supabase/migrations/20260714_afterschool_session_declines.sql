-- Batch B / Chunk 1: generalize session_declined_instructors to cover AFTER-SCHOOL
-- programs, not just camp sessions. Additive + backward-compatible: existing camp
-- rows (camp_session_id + cycle_id NOT NULL, program_id NULL) still satisfy every
-- constraint below.
--
-- Decline scope is per-PROGRAM (Jessica, 2026-07-14) — mirrors camp's per-session
-- scope. A program row carries program_id and leaves camp_session_id + cycle_id NULL
-- (programs live under `term`, not a scheduling_cycle).
--
-- RLS is unchanged: the three existing policies key on organization_id, so program
-- rows are covered automatically. GRANTs unchanged (authenticated already writes camp
-- declines through the same policies).

alter table public.session_declined_instructors
  alter column camp_session_id drop not null,
  alter column cycle_id drop not null,
  add column if not exists program_id uuid references public.programs(id) on delete cascade;

-- Exactly one parent: a row is either a camp-session decline or a program decline.
alter table public.session_declined_instructors
  drop constraint if exists session_declined_instructors_one_parent;
alter table public.session_declined_instructors
  add constraint session_declined_instructors_one_parent
  check ((camp_session_id is not null) <> (program_id is not null));

-- One decline per (program, instructor); mirrors the existing camp UNIQUE. Full (NOT
-- partial) index on purpose: camp rows have program_id NULL and NULLs are distinct in a
-- unique index, so camp rows never collide here. A full index is also inferable by
-- PostgREST's upsert onConflict — a PARTIAL index is NOT, which would 42P10 the client
-- write and silently drop every program decline.
drop index if exists public.session_declined_instructors_program_instructor_key;
create unique index if not exists session_declined_instructors_program_instructor_key
  on public.session_declined_instructors (program_id, instructor_id);
