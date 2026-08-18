-- STEP 1 of 3 for the cross-tenant sites leak: build the two SAFE reads.
-- NOTHING IS TAKEN AWAY HERE. public_read_program_locations stays until Home.jsx and
-- Register.jsx stop reading the base table, because dropping it first blanks every
-- registration page. Ship the side that fails safe first.
--
-- THE LEAK, proven by execution rather than by reading the policy.
-- public_read_program_locations is `TO public` with
--   organization_id IN (SELECT id FROM public_org_directory)
-- and permissive RLS policies OR together - so it grants anon AND every signed-in
-- user, for every org in the public directory. Ran the app's own query as a real
-- Cascade admin under RLS (set_config role + request.jwt.claims): 98 rows visible,
-- 13 their own, 85 another provider's.
--
-- On PROD, measured 2026-08-17: all 93 site rows across 4 orgs, carrying 55 phone
-- numbers, 53 arrival/dismissal briefings, 8 room numbers and 5 private notes. NOTE
-- for anyone working from the older notes: there are ZERO contact names and emails on
-- prod - the exposure is phone numbers. The "name, email and phone" figure was wrong.
--
-- RLS RESTRICTS ROWS, NOT COLUMNS. So the public half becomes a view over the safe
-- columns, mirroring districts_public.
create or replace view public.program_locations_public
  with (security_invoker = false) as
  select
    id,
    organization_id,
    name,
    address,
    district,      -- legacy free-text; the reg page still reads it
    district_id,   -- the structured link the picker groups on
    area           -- see 20260817c for why this is here; it is a FLOW requirement
  from public.program_locations
  where organization_id in (select public_org_directory.id from public_org_directory);

-- Readable by anon AND authenticated, deliberately. Parents have logins and are NOT
-- org_members, so scoping a public read to `anon` only is what blanked the district
-- picker for signed-in families on 2026-08-14. Do not "tighten" this to anon.
--
-- WRITE PRIVILEGES ARE REVOKED IN 20260817d, and that is not optional housekeeping:
-- the public schema's DEFAULT PRIVILEGES grant anon INSERT/UPDATE/DELETE/TRUNCATE on
-- every new view, these views are auto-updatable, and security_invoker=false means
-- DML runs as the owner, who bypasses RLS. Read 20260817d before touching this file.
grant select on public.program_locations_public to anon, authenticated;

comment on view public.program_locations_public is
  'Anon-safe site rows for the public registration catalog AND the instructor availability form. Readable by anon AND authenticated, because parents have logins and are NOT org_members - scoping this to anon only is what blanked the district picker for signed-in families on 2026-08-14. Exposes exactly (id, organization_id, name, address, district, district_id, area). Everything operator-only - contact_name/email/phone, arrival and dismissal instructions, room_number, notes, food_drink_policy, the parent_* instruction fields - stays on the base table behind members_read_program_locations and instructors_read_assigned_locations.';

-- THE THIRD AUDIENCE, which the approved plan did not have and whose absence would
-- have taken the instructor portal down.
--
-- Instructors are authenticated but are NOT org_members: is_org_member() reads only
-- the org_members table. So they reach location data SOLELY through the leaking
-- policy. Proven on staging as a real instructor with RLS enforced: 98 locations
-- visible today, and 0 after a naive drop of the public policy. On prod that is
-- J2S's 15 active instructors losing arrival instructions, dismissal instructions,
-- room numbers and the site phone - the entire briefing half of their portal.
--
-- Scoped to sites they are ACTUALLY ASSIGNED TO rather than their whole org, so a
-- one-class instructor does not get the provider's full site book. Mirrors
-- instructors_read_program_rosters, which already gates on
-- private.current_instructor_id() plus a CONFIRMED assignment. Covers both programs
-- and camps, because an instructor can be assigned either way.
--
-- Jessica approved the site phone number for assigned sites, 2026-08-17.
--
-- WHY THIS IS NOT THE READ PATH FOR THE AVAILABILITY FORM: an instructor states which
-- AREAS they can teach BEFORE any assignment exists. Gating that on an assignment is
-- a dependency loop - no assignment, no area list, no preference, no assignment. That
-- form reads program_locations_public instead; see 20260817c.
create policy instructors_read_assigned_locations
  on public.program_locations
  for select
  using (
    exists (
      select 1
      from public.program_assignments pa
      join public.programs p on p.id = pa.program_id
      where p.program_location_id = program_locations.id
        and pa.instructor_id = private.current_instructor_id()
        and pa.status = 'confirmed'
    )
    or exists (
      select 1
      from public.camp_assignments ca
      join public.camp_sessions cs on cs.id = ca.camp_session_id
      where cs.location_id = program_locations.id
        and ca.instructor_id = private.current_instructor_id()
        and ca.status = 'confirmed'
    )
  );
