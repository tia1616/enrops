-- Failure tracking for lifecycle automation sends.
--
-- Background: lifecycle-automations-cron used a "send first, and on failure write
-- NOTHING" pattern. A transient Resend failure therefore left no record at all —
-- invisible to operators, and recoverable only by luck on the next daily run (and
-- permanently lost if the audience window closed first). Real incident 2026-07-13:
-- "3 of 78 sends failed" with zero trace; three families silently missed their
-- camp welcome.
--
-- This migration is ADDITIVE and INERT: it adds two columns that the updated edge
-- function will populate. Existing rows default cleanly; nothing reads these until
-- the new function ships. The status CHECK already permits 'failed', so no
-- constraint change is needed to start recording failed sends.
--
--   attempts        - how many daily runs have tried this (context_key) send.
--                     Lets the cron cap retries (stop hammering a hard-bounce) and
--                     lets the operator "didn't send" surface show effort.
--   last_attempt_at - timestamp of the most recent send attempt (success OR fail).
--                     sent_at stays "when it actually sent"; last_attempt_at is the
--                     honest last-touch even for still-failing rows.

ALTER TABLE public.automation_run_recipients
  ADD COLUMN IF NOT EXISTS attempts        integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

-- Operator "welcomes/emails that didn't send" surface reads failed rows by org.
CREATE INDEX IF NOT EXISTS automation_run_recipients_failed_idx
  ON public.automation_run_recipients (organization_id, last_attempt_at DESC)
  WHERE status = 'failed';
