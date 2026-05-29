-- 20260529_pr6_sub_coordination_and_confirmation_uniqueness.sql
--
-- Two PR 6 additions:
--
-- 1. organizations.sub_coordination_notes — tenant-configurable middle
--    paragraph dropped into the 3-way sub-coordination email that fires
--    when a sub accepts an offer. The email itself is otherwise generic.
--    For J2S we seed the existing materials-handoff + lesson-sync ask;
--    other tenants edit or clear it. Empty string = paragraph omitted
--    cleanly (no extra blank line in the email body).
--
-- 2. Unique partial index on session_delivery_confirmations to prevent
--    duplicate rows on the same (instructor, target, date). Closes a
--    double-click race that confirm-session-taught + confirm-sub-delivery
--    both checked-then-inserted around — a true unique index is the
--    durable guard. Partial WHERE so both camp and program branches each
--    get their own uniqueness without collisions across kinds.

ALTER TABLE organizations
  ADD COLUMN sub_coordination_notes TEXT NOT NULL DEFAULT '';

UPDATE organizations
SET sub_coordination_notes = 'Please coordinate the sub having all the materials they need for the class. Also let them know which lesson(s) they should teach.'
WHERE id = '1adf10ad-d091-4aa0-82e3-af331468ea2b';

CREATE UNIQUE INDEX uq_session_delivery_confirmations_camp
  ON session_delivery_confirmations (instructor_id, camp_session_id, session_date)
  WHERE camp_session_id IS NOT NULL;

CREATE UNIQUE INDEX uq_session_delivery_confirmations_program
  ON session_delivery_confirmations (instructor_id, program_id, session_date)
  WHERE program_id IS NOT NULL;
