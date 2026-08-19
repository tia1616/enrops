-- program_seat_counts — the seat count that create-registration ENFORCES.
--
-- WHY THIS EXISTS
-- create-registration validated org, status and runs_own_registration but NEVER
-- counted seats, so a class could be oversold from an anonymous POST. Woodstock
-- (Super Mario Game Makers, FA26) reached its 14-seat cap with no gate anywhere.
--
-- DEFINITION, deliberately identical to what program_enrollment already showed:
--   seats_taken = registrations with status 'confirmed' OR 'pending'
-- A pending row is a checkout that has not paid yet. It still holds its seat.
-- Every pending row on prod today is older than 24h (23 rows across 11 open
-- programs), so those are dead checkouts holding real seats. That leak gets WORSE
-- once this gate exists - Happy Valley Library sits at 12/14 where 9 of the 12 are
-- ghosts - but expiring them changes a number the operator is already looking at,
-- so it is a separate explicit decision. NOT done here.
--
-- UNCAPPED MEANS NOT FULL. max_capacity NULL, 0 or negative => is_full = false.
-- "full" has to MEAN full; a missing or mis-entered cap is not a full class, and
-- treating it as one would turn every family away on a data-entry slip.
--
-- SECURITY DEFINER IS LOAD-BEARING HERE, and it is why this is a function rather
-- than a view. program_enrollment is security_invoker=on, so RLS on registrations
-- applies to the caller: read it as anon and every class reports enrolled=0 (all
-- 116 open classes on prod, verified). A gate that trusted that would never fire.
-- This function bypasses RLS on purpose so the count is true, and is therefore NOT
-- granted to anon.

create or replace function public.program_seat_counts(p_program_ids uuid[] default null)
returns table (
  program_id   uuid,
  max_capacity integer,
  seats_taken  bigint,
  is_full      boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.id,
    p.max_capacity,
    count(r.id) filter (where r.status = any (array['confirmed'::text, 'pending'::text])),
    case
      when coalesce(p.max_capacity, 0) > 0
        then count(r.id) filter (where r.status = any (array['confirmed'::text, 'pending'::text])) >= p.max_capacity
      else false
    end
  from programs p
  left join registrations r on r.program_id = p.id
  where p_program_ids is null or p.id = any (p_program_ids)
  group by p.id, p.max_capacity;
$$;

-- NOTE ON is_full: the capacity gate does NOT read it. is_full answers "is this
-- class full right now", which is the question a UI asks. The gate has to answer a
-- different one - "does THIS cart still fit" - because a cart can want more than one
-- seat in the same class (two siblings), so it compares seats_taken + requested
-- against max_capacity itself. The two agree whenever requested = 1; for requested > 1
-- the gate is correctly stricter. is_full is here for chunk 1's "Join the waitlist"
-- state. If you change what full means, change both and re-run the equivalence probe.

comment on function public.program_seat_counts(uuid[]) is
  'Canonical seat count per afterschool program, enforced by create-registration. seats_taken = confirmed + pending, matching what program_enrollment shows to a PRIVILEGED reader. is_full is false for an uncapped program (max_capacity NULL/0). SECURITY DEFINER on purpose: program_enrollment is security_invoker=on and reports enrolled=0 to anon, so the true count needs an RLS bypass. NOT granted to anon. Camps are NOT covered: camp_sessions has no capacity column and camp caps live on curricula.class_size_max.';

-- EXECUTE: service_role for the gate, authenticated for operator surfaces. NOT anon.
--
-- `revoke ... from public` is NOT sufficient on its own: Supabase sets DEFAULT
-- PRIVILEGES granting EXECUTE on new public functions to anon/authenticated/
-- service_role explicitly, so anon holds its own grant rather than inheriting via
-- PUBLIC. It has to be revoked by name. Caught by a control probe that was supposed
-- to fail and came back with 124 rows.
revoke all on function public.program_seat_counts(uuid[]) from public;
revoke execute on function public.program_seat_counts(uuid[]) from anon;
grant execute on function public.program_seat_counts(uuid[]) to service_role, authenticated;

-- ---------------------------------------------------------------------------
-- program_enrollment IS DELIBERATELY LEFT ALONE.
--
-- The first attempt repointed it at this function so one expression served both.
-- That was wrong, and the two reasons are worth keeping written down because
-- neither produced an error, a failed build, or a failed type-check:
--
--   1. `create or replace view` SILENTLY DROPPED `security_invoker=on`. Prod carries
--      that option; the recreated view came back with reloptions NULL, i.e. running
--      as owner and BYPASSING RLS on programs + registrations.
--   2. Function EXECUTE is checked against the CALLING role even when a view is
--      security_invoker=off, so a function-backed view needs anon to hold EXECUTE.
--      Revoking anon made the view 42501 for anonymous visitors - a dead page.
--
--   And the design consequence: this function is SECURITY DEFINER, so routing the
--   view through it would bake an RLS bypass into a surface that currently respects
--   RLS. Same numbers today, but it removes a protection that starts mattering the
--   moment RLS on registrations is tightened.
--
-- So the seats expression exists in two places on purpose. It is pinned by an
-- equivalence probe that must return zero before any ship:
--
--   select count(*) from program_enrollment v
--     join program_seat_counts() sc on sc.program_id = v.program_id
--    where v.enrolled is distinct from sc.seats_taken;
--
-- If you change one expression, change both and re-run that.
--
-- SEPARATELY, AND PRE-EXISTING: program_enrollment does not do what its own comment
-- claims. The comment says "SECURITY DEFINER is intentional - bypasses RLS on
-- registrations to compute accurate counts", but the view is security_invoker=on,
-- so as anon it reports enrolled=0 / spots_remaining=max_capacity for ALL 116 open
-- prod classes. Nothing parent-facing reads it today (only the admin schedule,
-- which runs authenticated), so no wrong number is on screen - but chunk 1 must not
-- build the public "class is full" state on top of it. Not fixed here; not mine to
-- widen quietly.
-- ---------------------------------------------------------------------------
