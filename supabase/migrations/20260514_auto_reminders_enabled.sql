-- Adds an auto_reminders_enabled flag on scheduling_cycles. The Send Offers
-- modal exposes this as a checkbox (default checked). The daily
-- offer-reminders-cron filters by this flag, so cycles with the flag off
-- are skipped entirely.

ALTER TABLE scheduling_cycles
  ADD COLUMN IF NOT EXISTS auto_reminders_enabled boolean NOT NULL DEFAULT true;
