-- Lets instructors read camp_sessions for assignments published to them.
-- Without this policy, the Instructor Portal's
-- camp_assignments(camp_sessions(...)) joined query returns empty rows
-- because RLS on camp_sessions previously only allowed org_admins and
-- org_members, not instructors. Symptom: portal shows "No schedule yet"
-- even though the instructor has live published assignments.

DROP POLICY IF EXISTS instructor_self_read_sessions ON camp_sessions;
CREATE POLICY instructor_self_read_sessions ON camp_sessions
  FOR SELECT
  USING (
    id IN (
      SELECT ca.camp_session_id
      FROM camp_assignments ca
      JOIN instructors i ON i.id = ca.instructor_id
      WHERE i.auth_user_id = auth.uid()
        AND ca.published_at IS NOT NULL
    )
  );
