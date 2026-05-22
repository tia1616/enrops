-- Lets instructors SELECT scheduling_cycles rows for cycles they have an
-- assignment in. Needed so the client-side `status != 'archived'` filter
-- on the schedule view actually filters (without this, the nested cycle
-- returns null under RLS and the filter is a no-op).
--
-- Scope is intentionally narrow: only cycles where the instructor has at
-- least one camp_assignment row. They cannot enumerate all cycles in
-- their org.
--
-- Applied 2026-05-22.

create policy instructor_self_cycles_read
  on public.scheduling_cycles
  for select
  using (
    id in (
      select distinct cs.cycle_id
      from public.camp_sessions cs
      join public.camp_assignments ca on ca.camp_session_id = cs.id
      where ca.instructor_id = private.current_instructor_id()
    )
  );
