-- get_sub_coverage — single source of truth for "needs cover" across BOTH the
-- schedule-page banner (NeedsCoverBanner.jsx) and the admin homescreen
-- (AdminOverview.jsx). Returns one row per genuinely-relevant upcoming sub slot.
--
-- WHY THIS EXISTS (2026-07-02): the two surfaces each hand-rolled the same
-- "declined => needs cover" logic, keyed ONLY on assignment_substitutions.status.
-- Neither checked whether the class is still happening, so a cancelled/withdrawn/
-- deleted parent left its sub-day stuck as status='declined' and both surfaces
-- screamed "needs cover" forever (hit prod: Jul-10 LEGO Superheroes [camp
-- cancelled] + an orphaned "A class" [parent assignment deleted]). This function
-- filters to LIVE parents only, so those false alarms cannot surface — for camps
-- AND programs (fall) alike.
--
-- Liveness = parent row still exists AND is not cancelled/withdrawn:
--   camp:    camp_assignments.status <> 'withdrawn'  AND camp_sessions.status = 'active'
--   program: program_assignments.status NOT IN ('withdrawn','cancelled') AND programs.status <> 'cancelled'
-- A deleted parent drops out via the inner join (orphan rows never surface).
--
-- Coverage precedence mirrors the old client logic exactly (there is exactly one
-- substitution row per parent+type+date — UNIQUE constraint — so no grouping):
--   confirmed/taught => covered (not returned)
--   pending          => 'awaiting' (offer still out; banner ignores, homescreen counts)
--   declined         => 'uncovered' (no one coming; banner shows, homescreen counts)
--
-- SECURITY INVOKER (default): runs as the caller, so underlying-table RLS filters
-- to the caller's org; the explicit organization_id = p_org is defense-in-depth.
-- Idempotent (create or replace). Mirrors get_home_signals conventions.
--
-- NOTE: get_home_signals also returns a `sub_coverage` count, but nothing reads it
-- (AdminOverview derives its needs-cover card from THIS rpc). That column is dead
-- + still lumps pending+declined without the liveness filter — leave it be here;
-- dropping it (and reconciling get_home_signals' repo↔DB drift) is backlogged.
create or replace function public.get_sub_coverage(p_org uuid)
returns table(
  parent_assignment_id uuid,
  parent_assignment_type text,
  slot_date date,
  state text,
  decliner_name text,
  curriculum_label text,
  location_label text
)
language sql
stable
set search_path to 'public'
as $$
  -- CAMP slots on live camps
  select
    a.parent_assignment_id,
    'camp'::text,
    a.date,
    case a.status when 'declined' then 'uncovered' else 'awaiting' end,
    case when a.status = 'declined'
      then nullif(trim(coalesce(nullif(i.preferred_name, ''), i.first_name, '') || ' ' || coalesce(i.last_name, '')), '')
      else null end,
    cs.curriculum_name,
    cs.location_name
  from assignment_substitutions a
  join camp_assignments ca
    on ca.id = a.parent_assignment_id
   and ca.organization_id = p_org
   and ca.status <> 'withdrawn'
  join camp_sessions cs
    on cs.id = ca.camp_session_id
   and cs.status = 'active'
  left join instructors i on i.id = a.sub_instructor_id
  where a.organization_id = p_org
    and a.parent_assignment_type = 'camp'
    and a.date >= current_date
    and a.status in ('pending', 'declined')

  union all

  -- PROGRAM slots on live programs (fall / after-school)
  select
    a.parent_assignment_id,
    'program'::text,
    a.date,
    case a.status when 'declined' then 'uncovered' else 'awaiting' end,
    case when a.status = 'declined'
      then nullif(trim(coalesce(nullif(i.preferred_name, ''), i.first_name, '') || ' ' || coalesce(i.last_name, '')), '')
      else null end,
    p.curriculum,
    pl.name
  from assignment_substitutions a
  join program_assignments pa
    on pa.id = a.parent_assignment_id
   and pa.organization_id = p_org
   and pa.status not in ('withdrawn', 'cancelled')
  join programs p
    on p.id = pa.program_id
   and p.status <> 'cancelled'
  left join program_locations pl on pl.id = p.program_location_id
  left join instructors i on i.id = a.sub_instructor_id
  where a.organization_id = p_org
    and a.parent_assignment_type = 'program'
    and a.date >= current_date
    and a.status in ('pending', 'declined');
$$;

revoke all on function public.get_sub_coverage(uuid) from anon, public;
grant execute on function public.get_sub_coverage(uuid) to authenticated;
