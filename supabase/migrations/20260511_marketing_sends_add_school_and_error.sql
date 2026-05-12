-- Adds columns and indexes for the FA26 marketing-send edge function.
-- Applied via Supabase MCP on 2026-05-11.

ALTER TABLE marketing_sends
  ADD COLUMN IF NOT EXISTS school_name TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS idx_marketing_sends_campaign_email_status
  ON marketing_sends(campaign_id, email, status);

CREATE INDEX IF NOT EXISTS idx_marketing_sends_org_campaign
  ON marketing_sends(organization_id, campaign_id);
