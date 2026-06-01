-- 20260601_programs_facility_request.sql
--
-- Track facility-booking status per program so the operator can check off
-- Facilitron / Mazevo / direct-partner requests as they're submitted and
-- approved. Replaces a Google Sheet that previously tracked the same two
-- dates + notes per class.
--
-- Per Jessica's standing rule the unit is per-program: one Facilitron
-- request = one room booking = one program. Bulk-approval districts are
-- the exception — for those you stamp all the programs at that school
-- at once.
--
-- No denied_at column for v1. If a request is denied, leave approved_at
-- null and write the reason in facility_notes; once you re-submit, update
-- facility_requested_at to the new date.

ALTER TABLE programs
  ADD COLUMN IF NOT EXISTS facility_requested_at date,
  ADD COLUMN IF NOT EXISTS facility_approved_at  date,
  ADD COLUMN IF NOT EXISTS facility_notes        text;

COMMENT ON COLUMN programs.facility_requested_at IS
  'Date the operator submitted the facility booking request (Facilitron / Mazevo / partner email). Null means not requested yet.';
COMMENT ON COLUMN programs.facility_approved_at IS
  'Date the facility request was approved. Null means still pending or denied — use facility_notes for context.';
COMMENT ON COLUMN programs.facility_notes IS
  'Free-text. "Waiting on PTA", "Denied — try Bonny Slope library instead", "Approved via partner email not Facilitron", etc.';

-- Sanity check (approved_at can only land after requested_at). Allow nulls.
ALTER TABLE programs
  ADD CONSTRAINT programs_facility_dates_check
  CHECK (
    facility_approved_at IS NULL
    OR facility_requested_at IS NULL
    OR facility_approved_at >= facility_requested_at
  );

COMMENT ON CONSTRAINT programs_facility_dates_check ON programs IS
  'Approval date cannot precede the request date. Either may be null while waiting on the workflow.';
