-- public_read_districts, scoped TO anon. Restores what 20260813c dropped, with
-- the role fixed. Read 20260813b/c/d as one change.
--
-- THE ORIGINAL DEFECT: the policy was `to public`, which includes
-- `authenticated`. Postgres ORs policies, so it overrode the org-scoped
-- org_access_districts sitting beside it and any operator could read every
-- active org's districts. Measured on staging: 1 owned, 8 readable.
--
-- MY DEFECT: I dropped it outright, having grepped for `.from("districts")` and
-- found only /admin callers. The public registration catalog reads districts as
-- a PostgREST embed — program_locations?select=...,districts(name) — which never
-- contains that string. That broke the district grouping on every public catalog
-- for the few minutes between 20260813c and this.
--
-- WHAT EACH ROLE GETS NOW:
--   anon          -> this policy, still narrowed by 20260806d's COLUMN grants to
--                    (id, organization_id, name). calendar_key,
--                    flyer_distribution and flyer_notes remain operator-only —
--                    that allowlist is the security control and is untouched.
--   authenticated -> org_access_districts only, so an operator sees their own
--                    org's districts and every column of them. That is what the
--                    School calendar page needs and what was broken: the page
--                    asks for calendar_key, which no column grant covered.
--
-- VERIFIED ON BOTH ENVIRONMENTS after applying, as real requests rather than
-- from the catalog:
--   prod   anon  program_locations?select=name,districts(name) -> 200 with names
--   prod   anon  districts?select=flyer_notes                  -> 401
--   prod   anon  districts?select=calendar_key                 -> 401
--   stg    authed districts?select=id,name,calendar_key        -> 200
--   stg    authed districts?select=id                          -> 1 row of 8

create policy public_read_districts
  on public.districts
  for select
  to anon
  using (
    organization_id in (select public_org_directory.id from public.public_org_directory)
  );
