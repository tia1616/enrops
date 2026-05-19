-- Chunk 3.6.01b — Touchpoints + cross-campaign throttle + promo codes extension
-- Conversation 2026-05-19
--
-- Notes:
--   - promo_codes ALREADY exists in this DB with a different shape than the
--     chunk's first draft. This migration extends it with the columns Don
--     needs for AI-suggested promos without disturbing existing rows.
--   - status CHECK on marketing_campaign_touchpoints is added as a separate
--     ALTER because the inline form tripped a Supabase migration runner quirk.

-- ============================================================
-- Touchpoints: each scheduled send / asset inside a campaign
-- ============================================================
CREATE TABLE IF NOT EXISTS marketing_campaign_touchpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('email', 'flyer', 'social')),
  order_index integer NOT NULL DEFAULT 0,
  scheduled_at timestamptz,
  status text NOT NULL DEFAULT 'queued',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  topics text[] DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  sent_at timestamptz,
  error_message text
);

ALTER TABLE marketing_campaign_touchpoints
  ADD CONSTRAINT marketing_campaign_touchpoints_status_check
    CHECK (status IN ('queued', 'sending', 'sent', 'skipped', 'failed', 'cancelled'));

CREATE INDEX IF NOT EXISTS idx_touchpoints_campaign
  ON marketing_campaign_touchpoints (campaign_id);
CREATE INDEX IF NOT EXISTS idx_touchpoints_org_status_scheduled
  ON marketing_campaign_touchpoints (organization_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_touchpoints_due
  ON marketing_campaign_touchpoints (scheduled_at)
  WHERE status = 'queued';

ALTER TABLE marketing_campaign_touchpoints ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON marketing_campaign_touchpoints TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON marketing_campaign_touchpoints TO service_role;

CREATE POLICY tp_org_member_read
  ON marketing_campaign_touchpoints FOR SELECT
  TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM org_members
      WHERE auth_user_id = auth.uid()
        AND accepted_at IS NOT NULL
    )
    OR EXISTS (SELECT 1 FROM platform_admins WHERE auth_user_id = auth.uid())
  );

CREATE POLICY tp_org_admin_write
  ON marketing_campaign_touchpoints FOR ALL
  TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM org_members
      WHERE auth_user_id = auth.uid()
        AND role IN ('owner','admin')
        AND accepted_at IS NOT NULL
    )
    OR EXISTS (SELECT 1 FROM platform_admins WHERE auth_user_id = auth.uid())
  );

-- ============================================================
-- promo_codes: extend the existing table (do NOT replace)
-- ============================================================
ALTER TABLE promo_codes
  ADD COLUMN IF NOT EXISTS scope_program_ids uuid[],
  ADD COLUMN IF NOT EXISTS starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_coupon_id text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id);

-- ============================================================
-- programs: pointer to currently-active promo
-- ============================================================
ALTER TABLE programs
  ADD COLUMN IF NOT EXISTS active_promo_code_id uuid REFERENCES promo_codes(id);

-- ============================================================
-- Cross-campaign throttle visibility
-- ============================================================
ALTER TABLE marketing_sends
  ADD COLUMN IF NOT EXISTS suppressed_by_throttle boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_marketing_sends_org_email_sent_at
  ON marketing_sends (organization_id, email, sent_at);

-- ============================================================
-- Per-org configuration: throttle window + timezone
-- ============================================================
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS email_throttle_days integer NOT NULL DEFAULT 10
    CHECK (email_throttle_days >= 0),
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/Los_Angeles';
