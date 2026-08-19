-- program_full_flags must be scoped to ONE organisation. Requiring the id array was not
-- enough, and this migration is the second attempt at the same hole.
--
-- WHAT 20260819i ACTUALLY CLOSED, AND WHAT IT DID NOT.
-- The original signature defaulted to NULL, and program_seat_counts reads a NULL array as
-- "every program", so `select * from program_full_flags()` returned the whole platform:
-- measured at 107 open programs across 7 organisations. Requiring the argument closed the
-- ARGUMENT-LESS call and nothing else. The function still has no org parameter and no org
-- filter, so a caller who can obtain program ids can still ask about all of them at once.
--
-- And anon CAN obtain them: public_read_programs is scoped to the public org DIRECTORY,
-- not to one org (20260627: `using (organization_id in (select id from
-- public_org_directory))`). So anon selects every listed org's open program ids in one
-- query, passes them as a single array, and gets the same cross-tenant sell-out census
-- back. Reporting the first fix as complete was wrong.
--
-- THE FIX IS AN ORG PARAMETER, not a longer guard list. "Which of MY classes are full" is
-- the question the catalog actually asks; "which of these arbitrary ids are full" never
-- was. With p_org_id required and joined, an array mixing two tenants returns only the
-- rows belonging to the org asked about, so the census cannot be assembled at any size.
--
-- Still SECURITY DEFINER, and still granted to anon: the true seat count lives behind RLS
-- on registrations, which is the whole reason this function exists rather than the
-- program_enrollment view (security_invoker = on, so anon correctly reads zeros there).

drop function if exists public.program_full_flags(uuid[]);

create or replace function public.program_full_flags(
  p_org_id      uuid,
  p_program_ids uuid[]
)
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
    -- THE ORG GATE. Rows for any other tenant are dropped even when their ids are in
    -- the array, so mixing tenants returns only what the caller asked about.
    and p.organization_id = p_org_id
    and p_org_id is not null
    -- Belt and braces on the array, kept from 20260819i: a NULL or empty array must
    -- never be read as "everything" by program_seat_counts.
    and p_program_ids is not null
    and cardinality(p_program_ids) > 0;
$$;

comment on function public.program_full_flags(uuid, uuid[]) is
  'Anon-safe full/not-full flags for ONE organisation''s OPEN programs, for the public catalog''s "Join the waitlist" state. Returns ONLY (program_id, is_full) - no counts, no capacity, no names. BOTH arguments are required and the org is joined, not merely trusted: an array mixing tenants returns only the rows owned by p_org_id. This is the second fix to the same hole - 20260819i required the array but left the function org-blind, and anon can enumerate open program ids across the public org directory, so requiring ids alone did not stop a cross-tenant census. Reads program_seat_counts so "full" is identical to what create-registration enforces. SECURITY DEFINER by necessity: the true count lives behind RLS on registrations.';

revoke all on function public.program_full_flags(uuid, uuid[]) from public;
grant execute on function public.program_full_flags(uuid, uuid[]) to anon, authenticated, service_role;
