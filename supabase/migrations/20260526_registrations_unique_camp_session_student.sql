-- Idempotency guard for roster imports. A student can appear at most once
-- on a given camp_session's roster. (Their parent could register
-- siblings — different student_ids — so the constraint is correctly
-- per-student, not per-parent.)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_registrations_camp_student
  ON registrations(camp_session_id, student_id)
  WHERE camp_session_id IS NOT NULL;
