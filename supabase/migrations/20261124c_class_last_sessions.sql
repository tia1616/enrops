-- 20261124c: per published weekly class, its last session, total sessions and
-- sessions left - readable by the public family page.
--
-- Why (Jessica 2026-11-24): a weekly class stays on sale until its LAST SESSION,
-- the per-class registration window other platforms use, and a family joining a
-- class that has already started pays only for the sessions left
-- (price x sessions left / total sessions; proratedBaseCents in src/lib/pricing.js
-- and supabase/functions/_shared/promoPricing.ts). The page needs the real dates
-- to show "Started Nov 2 - 4 of 8 sessions left" and that price, and only
-- derive_program_session_dates() knows them (school closures push sessions out).
-- That function runs as the caller, and anon cannot read
-- program_locations.closure_dates, so a signed-out visitor calling it fails.
-- This wrapper runs as the owner and returns ONLY a program id, a date and two
-- counts for PUBLISHED weekly classes of an ACTIVE business: no closure reasons,
-- no location data.
--
-- "Today" is the business's own timezone, the same day create-registration uses
-- (todayInTimezone), so the price on screen and the price charged agree. A
-- session dated today counts as left.
--
-- A season-switching business only shows its open season, so only those classes
-- are derived (J2S prod 11/24: all 111 classes, every term = 138 ms).
--
-- late_join_allowed (Jessica 11/24, "yes, add the setting"): a business can turn
-- late joining OFF, so a class stops selling once its first session has
-- happened (Sawyer's default). ON by default. Returned on every row so the
-- public page gets it from this one read; checkout reads the column itself.
alter table public.organizations
  add column if not exists late_join_allowed boolean not null default true;
comment on column public.organizations.late_join_allowed is
  'TRUE (default): families can join a weekly class after it starts, priced for the sessions left. FALSE: a class stops selling once its first session has happened. Read by classSeasons.isClassOnSale and create-registration.';

drop function if exists public.class_last_sessions(uuid);
create function public.class_last_sessions(p_organization_id uuid)
returns table(program_id uuid, last_session date, sessions_total integer, sessions_left integer, late_join_allowed boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id,
         (select max(d) from unnest(x.dates) d),
         coalesce(array_length(x.dates, 1), 0),
         (select count(*)::int from unnest(x.dates) d
           where d >= (now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date),
         o.late_join_allowed
    from public.programs p
    join public.organizations o
      on o.id = p.organization_id
     and o.status = 'active'
    cross join lateral (select public.derive_program_session_dates(p.id) as dates) x
   where p.organization_id = p_organization_id
     and p.status = 'open'
     and (p.class_days is null or p.class_days = '{}')
     and (o.classes_follow_dates or p.term = o.active_registration_term)
$$;

comment on function public.class_last_sessions(uuid) is
  'Per published weekly class of an active org: last session date, total sessions, sessions on or after today (org timezone), and whether the business lets families join after a class starts. Public (family page).';

revoke all on function public.class_last_sessions(uuid) from public, anon, authenticated;
grant execute on function public.class_last_sessions(uuid) to anon, authenticated, service_role;
