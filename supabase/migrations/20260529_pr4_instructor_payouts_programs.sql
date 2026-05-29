-- 20260529_pr4_instructor_payouts_programs.sql
--
-- PR 4 of the FA26 afterschool + sub flow build. Extends instructor_payouts
-- to support program (afterschool) payouts alongside camp payouts.
--
-- Today:
--   instructor_payouts has camp_session_id NOT NULL with a UNIQUE PARTIAL
--   INDEX (instructor_id, camp_session_id) WHERE status IN ('pending',
--   'succeeded') as the double-pay guard.
--
-- After:
--   camp_session_id is nullable. New nullable program_id column references
--   programs.id. A CHECK constraint enforces XOR — exactly one of
--   (camp_session_id, program_id) is set per row, never both, never
--   neither. A parallel partial unique index gives programs the same
--   no-concurrent-payout guarantee camps already have.
--
-- All existing rows (camp-only history) satisfy the new XOR check because
-- camp_session_id is set and program_id is NULL.

ALTER TABLE instructor_payouts
  ADD COLUMN program_id UUID REFERENCES programs(id) ON DELETE RESTRICT;

ALTER TABLE instructor_payouts
  ALTER COLUMN camp_session_id DROP NOT NULL;

ALTER TABLE instructor_payouts
  ADD CONSTRAINT instructor_payouts_camp_xor_program_check
  CHECK ((camp_session_id IS NOT NULL) <> (program_id IS NOT NULL));

-- Mirror of uq_instructor_payouts_no_concurrent for the program branch.
-- Both indexes coexist: each guards its own (instructor, target) pair.
CREATE UNIQUE INDEX uq_instructor_payouts_no_concurrent_program
  ON instructor_payouts (instructor_id, program_id)
  WHERE status IN ('pending', 'succeeded') AND program_id IS NOT NULL;

CREATE INDEX idx_instructor_payouts_program
  ON instructor_payouts (program_id) WHERE program_id IS NOT NULL;
