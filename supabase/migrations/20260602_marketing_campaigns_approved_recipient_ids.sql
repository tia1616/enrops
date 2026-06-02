-- Capture the resolved audience at approve time.
--
-- Today: marketing_campaigns has audience_filter (jsonb) + total_recipients (int)
-- but no list of actual recipient IDs. The cron has no way to know who to send to.
--
-- Two options were considered:
--   A. Add approved_recipient_ids uuid[] column (this migration)
--   B. Junction table marketing_campaign_recipients (campaign_id, recipient_id)
-- B is more relational but for a typical campaign (under ~5k recipients) the array
-- is fine, and one SELECT per cron tick beats a JOIN. If campaigns grow past a few
-- thousand recipients per campaign and we hit array limits or query perf, migrate
-- to a junction table then.
--
-- The column is populated by the approve flow in AICampaignBuilder.onApprove
-- (the only writer). The cron READS it; nobody else writes it.

ALTER TABLE marketing_campaigns
  ADD COLUMN IF NOT EXISTS approved_recipient_ids uuid[];

COMMENT ON COLUMN marketing_campaigns.approved_recipient_ids IS
  'List of marketing_recipients.id values captured at operator approve time. The cron passes this list to marketing-touchpoint-send for each scheduled touchpoint. Null until approved. Written exclusively by the approve flow.';
