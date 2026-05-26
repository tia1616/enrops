-- Lets org owners + admins update student fields (allergies, medical,
-- emergency contact, accommodations) for kids in their org's roster.
-- Without this, the /admin/rosters inline edit can only update
-- registration-level fields (registrations already has members_update_org_regs).
--
-- Scope is full WRITE (insert/update/delete) on the org's students.
-- Parents already have parents_manage_own_students for their own kids;
-- this adds the operator side so admins can patch the gaps Squarespace
-- doesn't capture (allergies, authorized pickup, accommodations).

DROP POLICY IF EXISTS members_update_org_students ON students;

CREATE POLICY members_update_org_students
  ON students
  FOR UPDATE
  USING (is_org_member(organization_id) OR is_platform_admin())
  WITH CHECK (is_org_member(organization_id) OR is_platform_admin());
