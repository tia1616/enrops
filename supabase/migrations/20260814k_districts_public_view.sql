-- districts_public: the district NAME, readable by every family - signed in or not.
--
-- THE BUG THIS FIXES (measured on prod 2026-08-14, both orgs):
--
--                        signed out (anon)   signed in (any account)
--   the-ukulele-project          4                     0
--   j2s                         19                     0
--
-- The public registration catalog reads district names to group schools. Since
-- 20260813d that read is a policy scoped `to anon`, and org access is granted by
-- org_members (check_org_access). PARENTS ARE NOT ORG MEMBERS. So the moment a
-- family signs in - which every returning family does, they have a parent
-- dashboard - districts come back empty and the grouping silently vanishes:
-- Jeff's catalog degrades to a flat alphabetical list of 17 schools, and J2S's
-- District dropdown collapses to the single "Other schools & sites" bucket with
-- all 28 schools under it. Reported by Jessica as "it's just a list of schools",
-- and only reproducible while signed in, which is why a signed-out check said
-- the page was fine.
--
-- 20260813d was RIGHT to scope the policy to anon. The policy sits beside
-- org_access_districts and Postgres ORs policies together, so widening it to
-- `authenticated` would re-open exactly the cross-tenant leak 20260813c/d
-- closed - and worse now, because 20260813b granted `authenticated` TABLE-level
-- SELECT, so it would expose calendar_key / flyer_distribution / flyer_notes of
-- every active org to any signed-in operator. RLS cannot restrict columns, so
-- the policy is the wrong instrument for this.
--
-- The right instrument is the one the house already uses for anon-safe reads:
-- a view. This mirrors class_schedule_public exactly (same filter on
-- public_org_directory, same grants) and carries ONLY the three columns anon
-- can already see. Nothing here is newly public - anon has read
-- (id, organization_id, name) since 20260806d. This extends the SAME three
-- columns to signed-in families. The operator-only columns are untouched and
-- remain reachable only through org_access_districts.
--
-- Default view semantics (security_invoker = false) are what make this work:
-- the view runs as its owner, so RLS on districts does not apply, and the WHERE
-- clause below IS the access control. It is stated explicitly rather than
-- relied on.

create or replace view public.districts_public
with (security_invoker = false) as
  select d.id,
         d.organization_id,
         d.name
  from public.districts d
  where d.organization_id in (select id from public.public_org_directory);

comment on view public.districts_public is
  'Anon-safe district names for the public registration catalog. Readable by anon AND authenticated, because parents are not org_members and a signed-in family must see the same grouping a signed-out one does. Only (id, organization_id, name) - operator-only columns (calendar_key, flyer_distribution, flyer_notes) stay behind org_access_districts on the base table.';

revoke all on public.districts_public from public;
grant select on public.districts_public to anon, authenticated;
