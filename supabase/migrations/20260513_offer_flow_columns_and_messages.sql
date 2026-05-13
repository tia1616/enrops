-- Offer flow: status enum updates, deadline/email tracking columns,
-- distance_bonus_cents (auto-set by trigger in a follow-up migration),
-- and the instructor_offer_messages thread table.

ALTER TABLE camp_assignments DROP CONSTRAINT IF EXISTS camp_assignments_status_check;
ALTER TABLE camp_assignments ADD CONSTRAINT camp_assignments_status_check
  CHECK (status = ANY (ARRAY['proposed', 'confirmed', 'change_requested', 'published', 'withdrawn', 'declined']));

ALTER TABLE camp_assignments
  ADD COLUMN IF NOT EXISTS change_request_message text,
  ADD COLUMN IF NOT EXISTS admin_response_message text,
  ADD COLUMN IF NOT EXISTS deadline date,
  ADD COLUMN IF NOT EXISTS email_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_viewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS distance_bonus_cents integer;

-- Seed the two known SU26 distance bonuses; trigger in the next migration
-- enforces the same rule (instructor marked region 'unavailable').
UPDATE camp_assignments SET distance_bonus_cents = 5000
  WHERE id IN ('51b58e64-d7c4-4826-b5d2-15a44fcbd2eb', '9b4cbf25-8d76-49c3-8105-763fb6cbfc6d');

CREATE TABLE IF NOT EXISTS instructor_offer_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  camp_assignment_id uuid NOT NULL REFERENCES camp_assignments(id) ON DELETE CASCADE,
  sender_role text NOT NULL CHECK (sender_role IN ('instructor', 'admin', 'system')),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_iom_assignment ON instructor_offer_messages(camp_assignment_id);
CREATE INDEX IF NOT EXISTS idx_iom_organization ON instructor_offer_messages(organization_id);

ALTER TABLE instructor_offer_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_admins_write_iom ON instructor_offer_messages;
CREATE POLICY org_admins_write_iom ON instructor_offer_messages
  FOR ALL
  USING (organization_id IN (
    SELECT om.organization_id FROM org_members om
    WHERE om.auth_user_id = auth.uid() AND om.role = ANY(ARRAY['owner','admin'])
  ));

DROP POLICY IF EXISTS instructor_self_iom_read ON instructor_offer_messages;
CREATE POLICY instructor_self_iom_read ON instructor_offer_messages
  FOR SELECT
  USING (camp_assignment_id IN (
    SELECT ca.id FROM camp_assignments ca
    JOIN instructors i ON i.id = ca.instructor_id
    WHERE i.auth_user_id = auth.uid()
  ));

DROP POLICY IF EXISTS instructor_self_iom_write ON instructor_offer_messages;
CREATE POLICY instructor_self_iom_write ON instructor_offer_messages
  FOR INSERT
  WITH CHECK (
    sender_role = 'instructor'
    AND camp_assignment_id IN (
      SELECT ca.id FROM camp_assignments ca
      JOIN instructors i ON i.id = ca.instructor_id
      WHERE i.auth_user_id = auth.uid()
    )
  );
