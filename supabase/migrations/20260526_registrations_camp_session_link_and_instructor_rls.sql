-- Adds camp_session_id to registrations so per-camper data for camps
-- (not just afterschool programs) can live in Enrops. Each registration
-- is for EXACTLY one of: a program (afterschool) or a camp_session.
--
-- Also grants instructors read access to registrations + students for
-- camp_sessions they have a confirmed assignment to. Without this,
-- AssignmentDetailView's roster section can't render anything because
-- the existing org_members policy doesn't apply to instructors (they
-- are not org_members; they live in `instructors`).

ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS camp_session_id UUID REFERENCES camp_sessions(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_registrations_camp_session
  ON registrations(camp_session_id)
  WHERE camp_session_id IS NOT NULL;

-- Enforce exactly-one-of constraint. Existing rows all have program_id
-- (camps were never tracked here), so this passes on backfill.
ALTER TABLE registrations
  DROP CONSTRAINT IF EXISTS registrations_one_program_or_camp_session;

ALTER TABLE registrations
  ADD CONSTRAINT registrations_one_program_or_camp_session CHECK (
    (program_id IS NOT NULL AND camp_session_id IS NULL)
    OR (program_id IS NULL AND camp_session_id IS NOT NULL)
  );

-- Instructors can read registrations for camps they're confirmed to teach.
DROP POLICY IF EXISTS instructors_read_camp_rosters ON registrations;

CREATE POLICY instructors_read_camp_rosters
  ON registrations
  FOR SELECT
  USING (
    camp_session_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM camp_assignments ca
      WHERE ca.camp_session_id = registrations.camp_session_id
        AND ca.instructor_id = private.current_instructor_id()
        AND ca.status = 'confirmed'
    )
  );

-- Instructors can read student rows tied to their roster registrations.
DROP POLICY IF EXISTS instructors_read_camp_roster_students ON students;

CREATE POLICY instructors_read_camp_roster_students
  ON students
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM registrations r
      JOIN camp_assignments ca ON ca.camp_session_id = r.camp_session_id
      WHERE r.student_id = students.id
        AND ca.instructor_id = private.current_instructor_id()
        AND ca.status = 'confirmed'
    )
  );

COMMENT ON COLUMN registrations.camp_session_id IS 'Set when this registration is for a camp_session (summer camps). NULL for afterschool program registrations. Exactly one of program_id or camp_session_id is non-null.';
