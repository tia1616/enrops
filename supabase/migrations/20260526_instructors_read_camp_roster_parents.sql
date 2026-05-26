-- Instructors can read parent rows for kids registered to camps they're
-- confirmed to teach. Parallel to instructors_read_camp_rosters (on
-- registrations) and instructors_read_camp_roster_students (on students).
-- Without this, the portal can render student fields but not contact info
-- for the parent who registered the camper.

DROP POLICY IF EXISTS instructors_read_camp_roster_parents ON parents;

CREATE POLICY instructors_read_camp_roster_parents
  ON parents
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM registrations r
      JOIN camp_assignments ca ON ca.camp_session_id = r.camp_session_id
      WHERE r.parent_id = parents.id
        AND ca.instructor_id = private.current_instructor_id()
        AND ca.status = 'confirmed'
    )
  );
