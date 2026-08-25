-- 20260825b_program_locations_public_view.sql
--
-- An anon-safe view of program_locations, so the public catalogue, the
-- registration page and the availability form stop reading the BASE TABLE.
-- Purely additive: it adds a read path and takes nothing away. 20260825d is the
-- migration that closes the hole; this one and 20260825c exist so that closing
-- it breaks nothing.
--
-- THIS FILE RECONCILES DRIFT. The view already existed on STAGING, applied
-- directly by another session with no migration file, and was absent from PROD
-- and from the repo (verified 2026-08-25: to_regclass is NULL on prod, and the
-- only repo hit for the name was this file). That is why the leak below is
-- still open - the groundwork was built on one environment and stopped there.
-- The column list here is character-for-character the one already on staging so
-- this is a no-op there and creates the same object on prod. Do not reorder the
-- columns: CREATE OR REPLACE VIEW cannot rename or reorder an existing view's
-- columns and fails with 42P16.
--
-- THE LEAK THIS IS GROUNDWORK FOR. `public_read_program_locations` is granted
-- `TO public` with USING (organization_id IN (SELECT id FROM
-- public_org_directory)) and no membership test. Permissive policies OR
-- together, so the org-scoped members_read_program_locations sitting beside it
-- restrains nothing. Measured on PROD 2026-08-25: 89 rows across 3 providers,
-- 55 with a school contact phone, 53 with an arrival briefing, 9 with a room,
-- 5 with private notes. contact_email and contact_name are unpopulated TODAY -
-- that is luck, not a control, and the grant covers them.
--
-- WHY A VIEW AND NOT A NARROWER GRANT. This was the obvious fix and it is
-- wrong. Column grants are per-ROLE, and an operator, a parent and an
-- instructor are all `authenticated` - Postgres cannot tell them apart. So
-- revoking contact_phone from `authenticated` to protect parents also revokes
-- it from the operator whose own site it is. Measured on prod, the reads that
-- would have started returning 42501 (PostgREST fails the WHOLE statement, not
-- the field):
--   portal/Dashboard.jsx:248         arrival_instructions, dismissal_instructions
--   portal/InstructorPortal.jsx:596  contact_phone, room_number, arrival_*, dismissal_*
--   portal/AfterschoolAvailabilityForm.jsx:129  area
--   every /admin site editor          contact_name, contact_email, notes
-- That is the districts.calendar_key incident again: 20260806d replaced a table
-- grant with a column allowlist, CalendarsList asked for an ungranted column,
-- and it sat broken in production for seven days until a live tenant reported
-- it. See scripts/check-select-grants.mjs, which exists because of that.
--
-- WHY THE POLICY ALONE IS ALSO NOT ENOUGH. Scoping public_read_program_locations
-- `TO anon` (what 20260813d did for districts) breaks the same surfaces for the
-- opposite reason: RLS is row-granular, and the users who need these rows are
-- not org_members. Counted on PROD 2026-08-25:
--   26 of 28 instructors are NOT org_members
--   180 of 182 signed-in parents are NOT org_members
-- They read this table today ONLY through the public policy. That is the
-- 20260814k regression exactly - districts went `TO anon`, and every signed-in
-- family lost the grouping (prod: j2s 19 districts signed out, 0 signed in).
--
-- So the fix is neither half on its own: the catalogue moves to a
-- column-limited VIEW (here), the two legitimate non-member readers get
-- relationship-scoped ROW policies (20260825c), and only then does the
-- cross-tenant policy get scoped to anon (20260825d).
--
-- COLUMN SET. Seven columns, all of which anon could already reach on the base
-- table EXCEPT `area`. Nothing operator-facing: no contact_name, contact_phone,
-- contact_email, notes, room_number, arrival_instructions or
-- dismissal_instructions. Those seven names are the whole reason this view
-- exists - do not add them.
--
-- `area` IS THE ONE ADDITION, and it is deliberate. anon's base-table allowlist
-- did not include it, so this widens anon by one column. It is a coarse region
-- label an operator types for instructor logistics ("NE Portland"); the same
-- row already exposes the full street `address` to anon, from which the area is
-- obvious. Carrying it here is what lets the instructor availability form drop
-- its table-wide read of program_locations without a fourth policy or an RPC -
-- one read path instead of two.
--
-- NOT CARRIED: name_aliases, slug, created_at. anon holds them on the base
-- table but no catalogue read asks for them (checked all five reads in
-- portal/Home.jsx, portal/Register.jsx and portal/AfterschoolAvailabilityForm.jsx).
-- Add them only when a reader needs one.
--
-- security_invoker = false (already the case on staging; stated explicitly
-- because it is the load-bearing part). The view runs as its owner, so a
-- signed-in parent who is not an org_member gets rows from it without needing
-- any policy on the base table. This mirrors districts_public (20260814k) and
-- class_schedule_public.
--
-- NO `archived` FILTER, deliberately. The reads this replaces filter nothing,
-- so filtering here would silently drop rows the catalogue expects and turn a
-- security fix into a content bug. The WHERE clause is character-for-character
-- the public policy's USING clause, so the row set is identical.

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
  where organization_id in (
    select public_org_directory.id from public.public_org_directory
  );

comment on view public.program_locations_public is
  'Anon-safe projection of program_locations for the public catalogue, the '
  'registration page and the instructor availability form, filtered to '
  'public_org_directory. security_invoker=false on purpose so a signed-in '
  'non-member (parent or instructor) can read it. Do NOT add operator-facing '
  'columns - contact_name/contact_phone/contact_email/notes/room_number/'
  'arrival_instructions/dismissal_instructions are the reason this view exists. '
  'Mirrors districts_public (20260814k).';

-- A view is a NEW object on prod, so Supabase's ALTER DEFAULT PRIVILEGES will
-- already have handed SELECT to anon and authenticated there. These grants are
-- belt-and-braces rather than the control, stated so a fresh apply on a
-- database with different defaults still lands right, and so this file matches
-- what staging already has. The CONTROL is the column list above.
grant select on public.program_locations_public to anon;
grant select on public.program_locations_public to authenticated;
grant select on public.program_locations_public to service_role;
