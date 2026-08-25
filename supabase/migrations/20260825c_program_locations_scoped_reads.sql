-- 20260825c_program_locations_scoped_reads.sql
--
-- The two legitimate NON-MEMBER readers of program_locations get their own
-- relationship-scoped row policies, plus one RPC for the availability form.
-- Additive: every one of these ADDS rows to what a caller can see. Nothing is
-- taken away until 20260825d.
--
-- WHY THIS EXISTS. Read 20260825b's header first for the leak and for why
-- neither a narrower grant nor an anon-only policy works on its own. The short
-- version: 26 of 28 instructors and 180 of 182 signed-in parents on PROD are
-- NOT org_members, so `public_read_program_locations` is the only thing
-- currently feeding them. Scope that to anon without these policies and the
-- parent dashboard and the whole instructor portal go blank.
--
-- These policies deliberately grant on the BASE TABLE, not the view, because
-- these two readers need columns the anon-safe view does not carry
-- (arrival/dismissal instructions, contact_phone, room_number). The control is
-- the ROW predicate: you get the site if you have a real relationship to it.

-- ── 1. Parents: the sites of classes their own child is registered for ──────
--
-- Serves portal/Dashboard.jsx:248, which reads
-- program_locations(name, arrival_instructions, dismissal_instructions) for the
-- parent's enrolled classes. That is the "where do I drop off and pick up"
-- panel - the arrival briefing is the single most load-bearing thing on it.
--
-- Mirrors the shape every other parent policy on this database already uses -
-- parents_see_own_regs, parents_see_own_students, parents_see_own_installments,
-- waiver_signatures, refunds - all of which are
-- `EXISTS (... WHERE r.parent_id = current_parent_id())`. Same spelling on
-- purpose; a second dialect for one rule is a future divergence.
--
-- current_parent_id() is STABLE SECURITY DEFINER and returns
-- `SELECT id FROM parents WHERE auth_id = auth.uid()`. For a caller with no
-- parent row - anon, or an operator - it returns NULL, and `r.parent_id = NULL`
-- is never true, so this fails CLOSED structurally. There is no boolean guard
-- here to get backwards; compare the fail-OPEN shape
-- `auth.uid() IS NOT NULL AND NOT authorised` that leaked parent emails on
-- 2026-08-20.
--
-- NO STATUS FILTER, deliberately. A registration moves through pending ->
-- paid -> cancelled and the dashboard renders more than one of those states.
-- Pinning this policy to one status is exactly the bug found in the instructor
-- policy below - the portal read a wider status set than the policy allowed, so
-- the location silently came back null. A parent who has ever registered a
-- child at a site may read that site; the site address is on their receipt
-- already.
--
-- BOTH program shapes. After-school classes hang off programs.program_location_id
-- and camps off camp_sessions.location_id; the dashboard renders both, so both
-- arms are needed. Querying only one is the "two tables, query all" trap.
create policy parents_read_enrolled_locations
  on public.program_locations
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.registrations r
      join public.programs p on p.id = r.program_id
      where p.program_location_id = program_locations.id
        and r.parent_id = public.current_parent_id()
    )
    or exists (
      select 1
      from public.registrations r
      join public.camp_sessions cs on cs.id = r.camp_session_id
      where cs.location_id = program_locations.id
        and r.parent_id = public.current_parent_id()
    )
  );

-- ── 2. Instructors: the sites of classes they have been OFFERED or teach ────
--
-- RECONCILING DRIFT, AND FIXING IT. A policy of this name was applied directly
-- to STAGING by another session with no migration file - it is absent from
-- prod and from the repo (verified 2026-08-25: prod has 3 policies on this
-- table, staging 4, and no migration mentions the name). This migration is that
-- policy's file, with one defect corrected, so a fresh apply and both
-- environments converge on the same definition.
--
-- THE DEFECT. The staging version required `pa.status = 'confirmed'`. Both
-- portal queries read THREE statuses:
--   InstructorPortal.jsx:596  program_assignments .in(status, [published, change_requested, confirmed])
--   InstructorPortal.jsx:543  camp_assignments    .in(status, [published, change_requested, confirmed])
-- So a `published` offer - one the instructor has been sent and has not yet
-- accepted - matched no policy row. Today that is invisible because the
-- cross-tenant public policy is still there to cover it; the moment 20260825d
-- scopes that to anon, every unaccepted offer would render with no location.
-- An instructor decides whether to accept an offer BY looking at where and when
-- it is, so this would have broken the offer flow itself, and only for offers
-- in flight - the hardest state to notice missing.
--
-- The status list here is the union the portal actually reads. `published_at IS
-- NOT NULL` is not re-tested: an unpublished draft assignment never carries one
-- of these three statuses, and duplicating the portal's filter in the policy is
-- how the two drift apart again.
--
-- private.current_instructor_id() is STABLE SECURITY DEFINER over
-- instructors.auth_user_id = auth.uid(), so it too returns NULL for a caller
-- with no instructor row and the comparison fails closed.
drop policy if exists instructors_read_assigned_locations on public.program_locations;
create policy instructors_read_assigned_locations
  on public.program_locations
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.program_assignments pa
      join public.programs p on p.id = pa.program_id
      where p.program_location_id = program_locations.id
        and pa.instructor_id = private.current_instructor_id()
        and pa.status in ('published', 'change_requested', 'confirmed')
    )
    or exists (
      select 1
      from public.camp_assignments ca
      join public.camp_sessions cs on cs.id = ca.camp_session_id
      where cs.location_id = program_locations.id
        and ca.instructor_id = private.current_instructor_id()
        and ca.status in ('published', 'change_requested', 'confirmed')
    )
  );

-- ── 3. The availability form's area list: NO new object needed ──────────────
--
-- portal/AfterschoolAvailabilityForm.jsx:129 reads program_locations.area for
-- the WHOLE org, filtered only by `area is not null`. An instructor fills that
-- form in BEFORE holding any assignment, so neither policy above covers it and
-- neither should: the answer it needs is "which parts of town does this
-- provider run in", not a site.
--
-- An earlier draft of this migration added an instructor_org_areas() RPC for
-- it. That is deleted, because program_locations_public (20260825b) already
-- carries `area` - so the form moves to the same view the catalogue uses and
-- needs no fourth policy and no new function. One read path, not two. A
-- policy would have been the wrong tool anyway: handing an instructor every ROW
-- of their org hands them every granted COLUMN of those rows, `notes` included.
--
-- The form's repoint is in the frontend half of this change.
