-- Bring an environment that already ran the ORIGINAL 20260819e into line with its
-- corrected version.
--
-- 20260819e shipped program_full_flags(p_program_ids uuid[] DEFAULT NULL). Because
-- program_seat_counts treats a NULL array as "every program", `select * from
-- program_full_flags()` returned the whole platform to any caller - and the function is
-- granted to anon. Measured on staging before the fix: 107 open programs across 7
-- organisations from one argument-less call.
--
-- 20260819e itself has been corrected in place (it had not reached prod, so prod gets the
-- right definition first time and never needs this file). This migration exists only for
-- STAGING, which had already applied the original. It is idempotent, so running it
-- against an environment that took the corrected 20260819e is harmless.
--
-- DROP before CREATE: removing a parameter DEFAULT is not something CREATE OR REPLACE is
-- guaranteed to do, and silently keeping the default would leave the hole open while
-- looking fixed.

drop function if exists public.program_full_flags(uuid[]);

create or replace function public.program_full_flags(p_program_ids uuid[])
returns table (program_id uuid, is_full boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select sc.program_id, sc.is_full
  from program_seat_counts(p_program_ids) sc
  join programs p on p.id = sc.program_id
  where p.status = 'open'
    -- Belt and braces: the required argument stops the no-arg call, and these stop a
    -- caller passing NULL or an empty array explicitly and getting the same bulk read.
    and p_program_ids is not null
    and cardinality(p_program_ids) > 0;
$$;

comment on function public.program_full_flags(uuid[]) is
  'Anon-safe full/not-full flag for OPEN programs, for the public catalog''s "Join the waitlist" state. Returns ONLY (program_id, is_full) - no counts, no capacity, no names. The id array is REQUIRED: it was optional until 2026-08-19, which let an anon caller read every open program on the platform (107 rows across 7 orgs on staging) instead of the classes they were looking at. Reads program_seat_counts so "full" is identical to what create-registration enforces. SECURITY DEFINER by necessity: the true count lives behind RLS on registrations.';

revoke all on function public.program_full_flags(uuid[]) from public;
grant execute on function public.program_full_flags(uuid[]) to anon, authenticated, service_role;
