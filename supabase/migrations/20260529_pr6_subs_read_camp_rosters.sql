-- 20260529_pr6_subs_read_camp_rosters.sql
--
-- PR 6 of the FA26 afterschool + sub flow build. Lets a confirmed sub read
-- the same camp roster the regular instructor sees, scoped to the
-- camp_session they're subbing on. Same shape as the existing
-- instructors_read_camp_rosters / _roster_students / _roster_parents
-- policies — just keyed off assignment_substitutions instead of
-- camp_assignments.
--
-- Status filter is ('confirmed','taught') — pending offers don't grant
-- roster access; the sub has to accept first. Declined/missed don't grant
-- either.
--
-- Scope is per-camp_session, not per-day. A sub on Tuesday gets to see the
-- full week's roster — same kids show up across days, subject to absences.
-- That matches how the regular instructor's access works.

-- ──────────────────────────────────────────────────────────────────────
-- registrations
-- ──────────────────────────────────────────────────────────────────────

CREATE POLICY subs_read_camp_rosters
  ON registrations
  FOR SELECT
  USING (
    (camp_session_id IS NOT NULL) AND EXISTS (
      SELECT 1
      FROM assignment_substitutions s
      JOIN camp_assignments ca ON ca.id = s.parent_assignment_id
      WHERE s.parent_assignment_type = 'camp'
        AND s.sub_instructor_id = private.current_instructor_id()
        AND s.status IN ('confirmed', 'taught')
        AND ca.camp_session_id = registrations.camp_session_id
    )
  );

-- ──────────────────────────────────────────────────────────────────────
-- students  (joined via the registration the sub can see)
-- ──────────────────────────────────────────────────────────────────────

CREATE POLICY subs_read_camp_roster_students
  ON students
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM registrations r
      JOIN assignment_substitutions s ON s.parent_assignment_type = 'camp'
      JOIN camp_assignments ca ON ca.id = s.parent_assignment_id
      WHERE r.student_id = students.id
        AND ca.camp_session_id = r.camp_session_id
        AND s.sub_instructor_id = private.current_instructor_id()
        AND s.status IN ('confirmed', 'taught')
    )
  );

-- ──────────────────────────────────────────────────────────────────────
-- parents  (joined via the registration the sub can see)
-- ──────────────────────────────────────────────────────────────────────

CREATE POLICY subs_read_camp_roster_parents
  ON parents
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM registrations r
      JOIN assignment_substitutions s ON s.parent_assignment_type = 'camp'
      JOIN camp_assignments ca ON ca.id = s.parent_assignment_id
      WHERE r.parent_id = parents.id
        AND ca.camp_session_id = r.camp_session_id
        AND s.sub_instructor_id = private.current_instructor_id()
        AND s.status IN ('confirmed', 'taught')
    )
  );
