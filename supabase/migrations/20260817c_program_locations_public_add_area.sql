-- `area` joins the safe columns, and the reason is a FLOW, not a field.
--
-- An instructor tells the provider which AREAS they can teach in, and the provider
-- assigns them afterwards. AfterschoolAvailabilityForm builds that list from
-- program_locations.area for their org.
--
-- The first cut of 20260817b scoped instructors to sites they were ASSIGNED to, which
-- inverts the order: no assignment means no area list, which means no stated
-- preference, which means no assignment. Jessica caught it, 2026-08-17: "an instructor
-- needs to tell me what areas they can teach in before i can give them assignments."
-- It was never a security trade-off to adjudicate - it was a sequence I had backwards.
--
-- THE FIX IS NOT A WIDER POLICY. The form needs ONE low-sensitivity column across the
-- org's sites, which is exactly what a public view is for. `area` is a city/region
-- label ("Multnomah County"), strictly less sensitive than the street ADDRESS this
-- same view already carries and that every registration page shows to the world. So
-- `area` goes public, the form reads the view, and instructors_read_assigned_locations
-- stays tight around the briefing columns - phone, room, arrival, dismissal - where
-- the assignment scope genuinely belongs.
--
-- Verified against the real starting state: a brand-new j2s instructor with ZERO
-- confirmed assignments reads 56 area rows across 15 distinct areas, and gets 0 sites'
-- briefing data. Both correct at the same time.
--
-- One edge worth knowing: the view is scoped to public_org_directory, which is
-- `status = 'active'`. An instructor at an INACTIVE org would see an empty area list.
-- No inactive org is running programs, so nothing is broken today - but if a provider
-- is ever paused mid-term, this is where their instructors' availability form goes
-- blank.
--
-- APPENDED, so CREATE OR REPLACE stays legal and the anon+authenticated grants
-- survive. security_invoker=false is RESTATED because CREATE OR REPLACE resets
-- reloptions - omitting it is how Jeff's registration page breaks a third time.
create or replace view public.program_locations_public
  with (security_invoker = false) as
  select
    id,
    organization_id,
    name,
    address,
    district,
    district_id,
    area
  from public.program_locations
  where organization_id in (select public_org_directory.id from public_org_directory);

comment on view public.program_locations_public is
  'Anon-safe site rows for the public registration catalog AND the instructor availability form. Readable by anon AND authenticated, because parents have logins and are NOT org_members - scoping this to anon only is what blanked the district picker for signed-in families on 2026-08-14. Exposes exactly (id, organization_id, name, address, district, district_id, area). `area` is here for a FLOW reason: an instructor states which areas they can teach BEFORE any assignment exists, so that list cannot be gated on having one. Everything operator-only - contact_name/email/phone, arrival and dismissal instructions, room_number, notes, food_drink_policy, the parent_* instruction fields - stays on the base table behind members_read_program_locations and instructors_read_assigned_locations.';
