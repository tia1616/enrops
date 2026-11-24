-- 20261124c: the last session date of each published weekly class, readable by
-- the public family page.
--
-- Why: a weekly class now stays on sale until its LAST SESSION (Jessica
-- 2026-11-24), the same "registration window per class" other registration
-- platforms use, instead of disappearing when its season ends. The family page
-- needs each class's true last date to apply that, and only
-- derive_program_session_dates() knows it (school closures push sessions out).
-- That function runs as the caller, and anon cannot read
-- program_locations.closure_dates, so a signed-out visitor calling it fails.
-- This wrapper runs as the owner and returns ONLY a program id and a date for
-- PUBLISHED weekly classes of an ACTIVE business: no closure reasons, no
-- location data, nothing the page does not already imply.
--
-- Read by src/pages/portal/Home.jsx (src/lib/classSeasons.js isClassOnSale).
-- Checkout (create-registration) applies the same rule with
-- derive_program_session_dates directly, as service role.
create or replace function public.class_last_sessions(p_organization_id uuid)
returns table(program_id uuid, last_session date)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id,
         (select max(d) from unnest(public.derive_program_session_dates(p.id)) as d)
    from public.programs p
    join public.organizations o
      on o.id = p.organization_id
     and o.status = 'active'
   where p.organization_id = p_organization_id
     and p.status = 'open'
     and (p.class_days is null or p.class_days = '{}')
$$;

comment on function public.class_last_sessions(uuid) is
  'Last session date of each published weekly class of an active org. Public (family page): a class is on sale until this date (classSeasons.isClassOnSale).';

revoke all on function public.class_last_sessions(uuid) from public, anon, authenticated;
grant execute on function public.class_last_sessions(uuid) to anon, authenticated, service_role;
