-- 20260603_automation_run_recipients.sql
--
-- Per-recipient send log + idempotency primitive for lifecycle automations.
--
-- Why a separate table from marketing_sends:
--   marketing_sends.campaign_id and recipient_id are NOT NULL — they're shaped
--   for promotional campaign delivery (audience = marketing_recipients rows
--   filtered by school). Lifecycle automations send to registration parents
--   directly, not via marketing_recipients. Mixing the two would either
--   require nulling those columns (breaks campaign queries) or fabricating
--   fake campaign rows (bad data).
--
-- Idempotency:
--   UNIQUE (automation_id, context_key) prevents a workflow from firing
--   twice for the same context. Context keys per workflow:
--     welcome_*           "program:{program_id}:parent:{parent_id}"
--     mid_recap           "program:{program_id}:parent:{parent_id}"
--     final_recap         "program:{program_id}:parent:{parent_id}"
--     check_in            "program:{program_id}:parent:{parent_id}"
--     birthday            "student:{student_id}:year:{YYYY}"
--     abandoned_reg       "registration:{registration_id}"
--     thank_you           "registration:{registration_id}"
--
-- The cron uses the conflict to dedupe — INSERT ... ON CONFLICT DO NOTHING
-- (or transactional pre-check) means a duplicate fire silently skips.

CREATE TABLE IF NOT EXISTS automation_run_recipients (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_run_id     uuid        NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  automation_id         uuid        NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  organization_id       uuid        NOT NULL,
  parent_id             uuid,
  context_key           text        NOT NULL,
  email                 text        NOT NULL,
  resend_message_id     text,
  status                text        NOT NULL,
  error_message         text,
  sent_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT automation_run_recipients_status_check CHECK (status IN (
    'sent', 'failed', 'skipped_unsubscribed', 'skipped_throttle'
  )),

  CONSTRAINT automation_run_recipients_unique_send UNIQUE (automation_id, context_key)
);

CREATE INDEX IF NOT EXISTS automation_run_recipients_by_run_idx
  ON automation_run_recipients (automation_run_id);

CREATE INDEX IF NOT EXISTS automation_run_recipients_by_automation_idx
  ON automation_run_recipients (automation_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS automation_run_recipients_by_org_idx
  ON automation_run_recipients (organization_id, sent_at DESC);

GRANT SELECT ON automation_run_recipients TO authenticated;

ALTER TABLE automation_run_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS members_read_automation_run_recipients ON automation_run_recipients;
CREATE POLICY members_read_automation_run_recipients
  ON automation_run_recipients
  FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());

COMMENT ON TABLE automation_run_recipients IS
  'Per-recipient send log for lifecycle automations. UNIQUE(automation_id, context_key) provides idempotency — cron cannot double-fire to the same context.';

COMMENT ON COLUMN automation_run_recipients.context_key IS
  'Idempotency key. Format: "program:UUID:parent:UUID" (welcomes/recaps), "student:UUID:year:YYYY" (birthday), "registration:UUID" (abandoned/thank-you).';
