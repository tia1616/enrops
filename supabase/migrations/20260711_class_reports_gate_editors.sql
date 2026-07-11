-- Gate the attendance safety/compliance report to org EDITORS (owner/admin/staff).
-- Security review 2026-07-11: Class Reports is a custody/dismissal log; the
-- read-only Viewer role should not see the who/when pickup history. Instructors
-- still read their OWN class via the instructor policies (unchanged); org editors
-- read + manage via the existing attendance_editor_write FOR ALL policy. This just
-- replaces the broad is_org_member read (which included viewers) with an
-- editor-scoped read, matching can_edit_org used for do_not_release.
--
-- Applied to staging (mumfymlapolsfdnpewci) then prod (iuasfpztkmrtagivlhtj),
-- same pass (parity).

DROP POLICY IF EXISTS attendance_member_read ON public.attendance_records;

CREATE POLICY attendance_editor_read ON public.attendance_records
  FOR SELECT
  USING (can_edit_org(organization_id) OR is_platform_admin());
