-- One definition of "enrolled", and a staffing count that no longer tallies
-- every tenant's registrations on each read.
--
-- program_staffing (20261014b) took `enrolled` from program_enrollment so the
-- rule lived in one place. But program_enrollment is a GROUPED view, and
-- Postgres cannot push "this class" into it: EXPLAIN on staging showed every
-- board load, home load and match run aggregating the registrations of every
-- program of every org, even with the org filter applied and even with
-- hash/merge joins disabled.
--
-- So the predicate becomes a function - the same shape as
-- registration_holds_seat(), which program_enrollment already calls for
-- seats_taken - and BOTH views call it:
--   * program_enrollment.enrolled: identical output (proven by hashing every
--     row before and after on both databases).
--   * program_staffing.enrolled: a per-class count that uses
--     idx_registrations_program, so cost scales with the org being read.
--
-- Plain SQL, SECURITY INVOKER, inlinable: RLS on registrations still decides
-- what each caller can count, exactly as before.

create or replace function public.registration_is_enrolled(r public.registrations)
returns boolean
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  -- In the class: not cancelled, and paid or confirmed. A pending checkout, a
  -- waitlist row or a cancelled/refunded one is not a child in the room. This
  -- is NOT registration_holds_seat(), which also counts checkouts in flight
  -- and live waitlist offers - that is "a chair nobody else can buy".
  select r.cancelled_at is null and (r.payment_status = 'paid' or r.status = 'confirmed');
$$;

comment on function public.registration_is_enrolled(public.registrations) is
  'Is this child actually in the class? Not cancelled, and paid or confirmed. The one definition behind program_enrollment.enrolled and program_staffing.enrolled.';

-- Same columns, same order, same output; only `enrolled` now calls the function.
-- WITH (security_invoker) is restated on purpose: CREATE OR REPLACE VIEW without
-- it resets the option. Grants survive OR REPLACE.
create or replace view public.program_enrollment
with (security_invoker = on) as
 SELECT p.id AS program_id,
    p.curriculum,
    pl.name AS program_location_name,
    pl.name AS school_name,
    p.day_of_week,
    p.max_capacity,
    count(r.id) FILTER (WHERE registration_is_enrolled(r.*)) AS enrolled,
        CASE
            WHEN p.max_capacity IS NULL OR p.max_capacity <= 0 THEN NULL::bigint
            ELSE GREATEST(0::bigint, p.max_capacity - count(r.id) FILTER (WHERE registration_holds_seat(r.*)))
        END AS spots_remaining,
    count(r.id) FILTER (WHERE registration_holds_seat(r.*)) AS seats_taken
   FROM programs p
     JOIN program_locations pl ON p.program_location_id = pl.id
     LEFT JOIN registrations r ON r.program_id = p.id
  GROUP BY p.id, p.curriculum, pl.name, p.day_of_week, p.max_capacity;

-- Per-class count instead of a join to the grouped view. One behavioural
-- difference, deliberately: a class with no site row used to read 0 here
-- (program_enrollment inner-joins program_locations); it now counts its real
-- registrations, which is what a staffing decision should use.
create or replace view public.program_staffing
with (security_invoker = on) as
select
  p.id as program_id,
  p.organization_id,
  p.instructors_needed as base_instructors_needed,
  p.second_instructor_after_registrations,
  en.enrolled,
  case
    when p.second_instructor_after_registrations is not null
     and en.enrolled > p.second_instructor_after_registrations
      then greatest(p.instructors_needed, 2)
    else p.instructors_needed
  end as instructors_needed
from public.programs p
cross join lateral (
  select count(*) as enrolled
  from public.registrations r
  where r.program_id = p.id and public.registration_is_enrolled(r)
) en;

comment on view public.program_staffing is
  'Effective instructors needed per program right now: programs.instructors_needed, raised to 2 once enrollment passes second_instructor_after_registrations. The single source for the schedule board, match-afterschool and the home page.';

revoke all on public.program_staffing from public, anon, authenticated;
grant select on public.program_staffing to authenticated, service_role;
