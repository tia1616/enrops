-- Per-org marketing email suppression list.
-- Honors CAN-SPAM opt-outs and Gmail/Yahoo one-click unsubscribe (RFC 8058).
-- An email in this table is excluded from marketing-send for the corresponding org.
-- Org-scoped on purpose: unsubscribing from org A does not affect org B.

CREATE TABLE marketing_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  suppressed_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('email_reply', 'one_click', 'link_click', 'manual', 'complaint')),
  reason text,
  user_agent text,
  ip_address text
);

CREATE UNIQUE INDEX uq_marketing_suppressions_org_email
  ON marketing_suppressions (organization_id, lower(email));

CREATE INDEX idx_marketing_suppressions_email_lookup
  ON marketing_suppressions (organization_id, lower(email));

ALTER TABLE marketing_suppressions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_members_read_own_suppressions"
  ON marketing_suppressions
  FOR SELECT
  TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM org_members WHERE auth_user_id = auth.uid()
    )
  );

COMMENT ON TABLE marketing_suppressions IS 'Per-org email suppression list. Excluded from marketing-send. Populated by marketing-unsubscribe (link click + one-click) and manual inserts (email replies).';
