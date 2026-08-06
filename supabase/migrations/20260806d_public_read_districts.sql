-- 20260806d_public_read_districts.sql
--
-- Let the public registration catalog read district NAMES.
--
-- WHY. The catalog groups locations by district. It used to group by
-- program_locations.district (legacy free text); it now reads the district a
-- provider actually PICKED, districts.name. But `districts` had exactly one
-- policy - org_access_districts, ALL, check_org_access(organization_id) - so an
-- anonymous visitor got nothing back and the embed 401'd. Verified as anon with
-- the real anon key before writing this: districts returned zero rows, and
-- program_locations?select=...,districts(name) returned 401.
--
-- Caught only by loading the actual rendered page. The same nested embed tested
-- fine with the service key, which bypasses RLS - so it looked correct right up
-- until a real anonymous visit showed no district tier at all.
--
-- EXPOSURE. This is the identical envelope the catalog's other two tables already
-- use, not a new one:
--
--   public_read_programs           USING (organization_id IN (SELECT id FROM public_org_directory))
--   public_read_program_locations  USING (organization_id IN (SELECT id FROM public_org_directory))
--
-- public_org_directory is the curated set of orgs that publish a catalog, so this
-- is NOT blind-enumerable across every tenant - it is scoped to orgs that have
-- deliberately made a registration page public. And it adds no new information: if
-- a family can already see "Ainsworth Elementary School" in a provider's open
-- classes, the district that school sits in is not a secret. District names are
-- public-school district names.
--
-- SELECT only. Nothing about this lets an anonymous visitor write a district, and
-- the existing org_access_districts policy still governs every member operation.
-- Deliberately does NOT expose calendar_key / flyer_distribution / flyer_notes at
-- the policy level; those are operator-facing columns on the same row, so the
-- FRONTEND must keep selecting only `name` (it does). If a future caller needs
-- column-level enforcement, that wants a view, not a wider policy.

drop policy if exists public_read_districts on public.districts;
create policy public_read_districts
  on public.districts
  for select
  to public
  using (
    organization_id in (select public_org_directory.id from public.public_org_directory)
  );

-- anon needs the table-level SELECT grant as well as the policy. Granted
-- explicitly rather than relied on from Supabase's default privileges, so this is
-- readable as intent and survives a future blanket revoke.
grant select on public.districts to anon;
grant select on public.districts to authenticated;

-- ── the second half, and the one that actually broke the page ────────────────
--
-- program_locations does NOT grant anon SELECT on the whole table. The RBAC
-- hardening gave it a COLUMN-LEVEL allowlist, and anon's SELECT columns are:
--   address, created_at, district, id, name, name_aliases, organization_id, slug
--
-- `district_id` is absent, so PostgREST could not traverse the FK and the embed
-- failed with 42501 "permission denied for table program_locations" - pointing at
-- the PARENT table, not at districts, which is what made it confusing. Note the
-- allowlist DOES include `district`, the legacy text column: that is precisely why
-- the old grouping worked and the new one did not.
--
-- This adds exactly one column to an existing, deliberate allowlist - the same
-- thing the previous author did for the columns the catalog needed then. It is a
-- FK uuid, not data: on its own it identifies a district row, and reading that row
-- is governed by public_read_districts above.
--
-- Kept as a column grant rather than widening to `grant select on
-- program_locations`, which would hand anon every operator-facing column on the
-- table (contact_name, contact_phone, contact_email, arrival/dismissal
-- instructions, notes). The allowlist is the security control; do not trade it for
-- convenience.
grant select (district_id) on public.program_locations to anon;
grant select (district_id) on public.program_locations to authenticated;
