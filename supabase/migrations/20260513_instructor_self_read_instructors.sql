-- Lets an instructor read their own row in the instructors table.
-- Without this, the existing instructor_self_assignments_read policy on
-- camp_assignments collapses to empty, because its inner subquery does
--   SELECT FROM instructors WHERE auth_user_id = auth.uid()
-- and the caller has no SELECT permission on instructors. That cascaded
-- into the camp_sessions read policy also returning empty (since the
-- session policy depends on camp_assignments reads), and the Instructor
-- Portal silently showed "No schedule yet" even for instructors with live
-- published assignments. Verified Kyle's full join returns his rows after
-- this policy is applied.

DROP POLICY IF EXISTS instructor_self_read_instructors ON instructors;
CREATE POLICY instructor_self_read_instructors ON instructors
  FOR SELECT
  USING (auth_user_id = auth.uid());
