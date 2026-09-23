-- Camp registration, chunk 1: give a camp a seat cap, and a way to count seats.
--
-- Camps have never had a capacity field. `current_enrollment` is a number synced
-- in from Squarespace AFTER the fact, not a limit - one SU26 session sits at 17
-- against a curriculum that caps at 14, because nothing ever refused a 15th. The
-- moment enrops itself sells a camp, something has to refuse.
--
-- SHAPE COPIED FROM PROGRAMS, deliberately, rather than invented:
--   programs.max_capacity is a per-row number SEEDED from curricula.class_size_max
--   when the program is created (ProgramWizardNew prefills it, operator can override),
--   and owned by the row thereafter. Camps already carry curriculum_id, so the same
--   seeding works. A per-session number is the right grain, not a per-curriculum one:
--   the same camp in a smaller room holds fewer children.
--
-- Both objects are INERT on arrival. Nothing reads max_capacity and nothing calls
-- camp_session_seat_counts until chunk 2 wires create-registration to it.

alter table public.camp_sessions
  add column if not exists max_capacity integer;

comment on column public.camp_sessions.max_capacity is
  'Seat cap for this camp session. NULL or <= 0 means uncapped - a missing cap is '
  'not a full camp. Seeded from curricula.class_size_max at creation, then owned by '
  'this row. Mirrors programs.max_capacity.';

-- Seat counts for camps. Twin of program_seat_counts, down to the grants.
--
-- SECURITY DEFINER for the same reason its twin is: registrations RLS applies to
-- the caller, and a gate that reads 0 enrolled for every camp would never fire.
-- It reuses registration_holds_seat(r) rather than restating which statuses hold a
-- seat - one rule, one place. That predicate already counts pending as well as
-- confirmed, so a camp seat is held from the moment checkout starts and the
-- webhook's pending -> confirmed flip stays seat-neutral.
--
-- UNCAPPED IS NOT FULL: max_capacity NULL or <= 0 reports is_full=false.
create or replace function public.camp_session_seat_counts(
  p_camp_session_ids uuid[] default null::uuid[]
)
returns table(camp_session_id uuid, max_capacity integer, seats_taken bigint, is_full boolean)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select
    cs.id,
    cs.max_capacity,
    count(r.id) filter (where registration_holds_seat(r)),
    case
      when coalesce(cs.max_capacity, 0) > 0
        then count(r.id) filter (where registration_holds_seat(r)) >= cs.max_capacity
      else false
    end
  from camp_sessions cs
  left join registrations r on r.camp_session_id = cs.id
  where p_camp_session_ids is null or cs.id = any (p_camp_session_ids)
  group by cs.id, cs.max_capacity;
$function$;

-- Grants mirror program_seat_counts exactly: {postgres, service_role} and nothing
-- else. Only the edge function calls this, with the service-role client.
--
-- REVOKING FROM public IS NOT ENOUGH, and this is not theoretical: applying this
-- migration with only the `from public` line left proacl as
--   {postgres=X, anon=X, authenticated=X, service_role=X}
-- on staging. Supabase's default privileges grant EXECUTE to anon and authenticated
-- EXPLICITLY on every new function in public, and an explicit grant survives a
-- revoke aimed at PUBLIC. That is the same hole that leaked parent emails on
-- 2026-08-20. Name both roles, then read proacl back and prove it - a green
-- migration says the statements parsed, never that the grants are what you wanted.
revoke all on function public.camp_session_seat_counts(uuid[]) from public;
revoke all on function public.camp_session_seat_counts(uuid[]) from anon;
revoke all on function public.camp_session_seat_counts(uuid[]) from authenticated;
grant execute on function public.camp_session_seat_counts(uuid[]) to service_role;
