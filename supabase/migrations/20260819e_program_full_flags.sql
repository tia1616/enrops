-- The public catalog needs to know a class is full. Today it cannot.
--
-- program_enrollment is security_invoker=on (2026-06-06 hotfix, because as a DEFINER
-- view it exposed every tenant's programs, locations and FILL RATES to anon), so an
-- anonymous visitor reads enrolled=0 for every class - by design. A "Join the waitlist"
-- button built on it would never appear.
--
-- So the catalog gets its own reader, and it is deliberately the narrowest thing that
-- works: ONE BOOLEAN PER OPEN PROGRAM. No counts, no capacity, no seats remaining, no
-- names, no locations. Jessica chose full/not-full over showing spots remaining
-- (2026-08-19).
--
-- WHY THIS IS NOT THE THING THE JUNE HOTFIX CLOSED. That hotfix was about fill RATES
-- plus identifying detail across tenants - "Ukulele Club at Alameda is 12 of 15" is
-- competitive information. "This class is full" is not: it is the same fact a family
-- learns by clicking Register, on classes the catalog already lists publicly. A boolean
-- cannot be differenced over time to infer enrolment the way a count can.
--
-- Still scoped as tightly as it can be:
--   * status = 'open' only. Draft and closed classes are invisible here, so an operator's
--     unpublished plans stay unpublished.
--   * returns only (program_id, is_full). Nothing joinable to a person.
--   * reads program_seat_counts, so "full" means exactly what the capacity gate enforces
--     and what the operator's screen shows. One rule, three consumers.

create or replace function public.program_full_flags(p_program_ids uuid[] default null)
returns table (program_id uuid, is_full boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select sc.program_id, sc.is_full
  from program_seat_counts(p_program_ids) sc
  join programs p on p.id = sc.program_id
  where p.status = 'open';
$$;

comment on function public.program_full_flags(uuid[]) is
  'Anon-safe full/not-full flag for OPEN programs, for the public catalog''s "Join the waitlist" state. Returns ONLY (program_id, is_full) - no counts, no capacity, no names - because program_enrollment is security_invoker=on and correctly shows anon zeros. Reads program_seat_counts so "full" is identical to what create-registration enforces. SECURITY DEFINER by necessity: the true count lives behind RLS on registrations.';

revoke all on function public.program_full_flags(uuid[]) from public;
grant execute on function public.program_full_flags(uuid[]) to anon, authenticated, service_role;
