-- 20260529_roster_email_sends.sql
--
-- Audit log of roster emails sent from the Rosters page to partner
-- contacts. One row per send (which may include multiple recipients).
-- Lets the Rosters UI display "Last sent to X on …" and gives the operator
-- a permanent record of which partner received what when.

CREATE TABLE IF NOT EXISTS roster_email_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  camp_session_id UUID NOT NULL REFERENCES camp_sessions(id) ON DELETE CASCADE,
  partner_id UUID REFERENCES partners(id) ON DELETE SET NULL,
  sent_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Snapshot of who actually received the email at send time. Shape:
  --   [{ "name": "Jane Doe", "email": "jane@school.edu", "role": "operational", "source": "partner_contact" }, ...]
  -- Source = 'partner_contact' | 'location_contact' | 'ad_hoc_cc'.
  recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  message TEXT,
  resend_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'failed')),
  failure_reason TEXT,
  roster_camper_count INTEGER NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_roster_email_sends_organization_id
  ON roster_email_sends(organization_id);
CREATE INDEX IF NOT EXISTS idx_roster_email_sends_camp_session_id
  ON roster_email_sends(camp_session_id);
CREATE INDEX IF NOT EXISTS idx_roster_email_sends_sent_at_desc
  ON roster_email_sends(camp_session_id, sent_at DESC);

COMMENT ON TABLE  roster_email_sends IS 'Audit of camp roster emails sent to partner logistics contacts.';
COMMENT ON COLUMN roster_email_sends.recipients IS 'Snapshot of recipients at send time. Each item: { name, email, role, source }.';
COMMENT ON COLUMN roster_email_sends.resend_message_id IS 'Resend API message id, for tracing deliveries in Resend dashboard.';
COMMENT ON COLUMN roster_email_sends.roster_camper_count IS 'Camper count baked into the PDF at send time. Useful to spot stale-roster sends.';

ALTER TABLE roster_email_sends ENABLE ROW LEVEL SECURITY;

-- Org members can read their org's send history. Writes happen via the
-- edge function with the service-role key, so no INSERT/UPDATE policy is
-- needed for authenticated users.
CREATE POLICY roster_email_sends_org_read
  ON roster_email_sends
  FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());

-- Per the project's 2026-10-30 migration rule: explicit grants on new
-- public tables. RLS still gates row visibility.
GRANT SELECT ON roster_email_sends TO authenticated;
-- INSERTs come from the edge function via service role; no anon access.
