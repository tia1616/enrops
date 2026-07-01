-- INCIDENT FIX: the public registration funnel was broken for logged-out (and
-- non-member) visitors. The secure-organizations migration (2026-06-25) revoked
-- anon's read access to the `organizations` table, but these public-read RLS
-- policies filter via `organization_id IN (SELECT id FROM organizations WHERE
-- status='active')`. That subquery returns NOTHING for anon, so anon saw zero
-- programs / schools / branding / waivers / promo codes / session dates — i.e.
-- the catalog + register flow showed nothing for anyone not signed in as an org
-- member. (Proven on prod: anon read 0 of J2S's 29 open FA26 programs.)
--
-- Fix: re-point each subquery at `public_org_directory` — the anon-readable,
-- security-definer view of active orgs that the secure-org work created. Same
-- "active orgs" intent; the view exposes only safe columns, so no sensitive org
-- data is re-exposed.
alter policy public_read_programs on public.programs
  using (organization_id in (select id from public.public_org_directory));

alter policy public_read_program_locations on public.program_locations
  using (organization_id in (select id from public.public_org_directory));

alter policy public_read_branding on public.org_branding
  using (organization_id in (select id from public.public_org_directory));

alter policy public_read_district_calendars on public.district_calendars
  using (organization_id in (select id from public.public_org_directory));

alter policy public_read_active_waivers on public.waivers
  using ((active = true) and (organization_id in (select id from public.public_org_directory)));

alter policy public_read_promo_codes on public.promo_codes
  using ((active = true) and (organization_id in (select id from public.public_org_directory)));
