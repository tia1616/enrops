-- Adds a flagged_reason column so the offer auto-expire cron can mark rows
-- where the deadline has passed without changing their status. The UI's
-- deriveStatus maps flagged_reason IS NOT NULL → flagged-state (gold border),
-- so the card visually flags without us needing a new status enum value.
--
-- Partial index speeds up the daily expire pass that scans only
-- still-published rows by deadline.

ALTER TABLE camp_assignments
  ADD COLUMN IF NOT EXISTS flagged_reason text;

CREATE INDEX IF NOT EXISTS idx_camp_assignments_published_deadline
  ON camp_assignments(deadline)
  WHERE status = 'published';
