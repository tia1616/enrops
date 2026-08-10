-- Registration close window, per org.
--
-- Every program's registration closes a fixed number of days before its first
-- session. J2S closes 7 days out; that is a business practice, not a platform
-- constant, so it lives on the org rather than in the token builder. A tenant
-- that closes 3 days out (or the day before) sets its own number.
--
-- This is what {{registration_close_date}} resolves against in
-- marketing-touchpoint-send: first_session_date - registration_close_days_before,
-- computed per recipient's program so one campaign can carry the right date for
-- every school in it.
--
-- Additive and inert: the default reproduces J2S's current practice exactly, and
-- nothing reads the column until the token ships. No behavior changes on apply.
--
-- NOTE: nothing in the platform ENFORCES this window today - registration stays
-- open until the operator changes the program's status by hand. This column
-- describes the operator's practice so email copy can state it accurately; it
-- does not gate checkout. Enforcement is a separate decision.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS registration_close_days_before integer NOT NULL DEFAULT 7;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'organizations'::regclass
      AND conname = 'organizations_registration_close_days_before_check'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_registration_close_days_before_check
      CHECK (registration_close_days_before >= 0);
  END IF;
END $$;

COMMENT ON COLUMN organizations.registration_close_days_before IS
  'Days before a program''s first session that registration closes. Drives the {{registration_close_date}} merge token. Descriptive of operator practice - not enforced at checkout.';
