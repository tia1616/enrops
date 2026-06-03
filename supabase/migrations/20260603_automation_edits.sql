-- 20260603_automation_edits.sql
--
-- Append-only history of operator edits to automation overrides.
--
-- WHY: when an operator customizes a thank_you / welcome / recap body or
-- subject, that's a voice signal — what they prefer, what they drop, what
-- they add. Today Ennie reads `organizations.brand_voice` (jsonb) for static
-- voice prefs (closer, tone, do_use, do_not_use). This table is the
-- foundation for the dynamic, append-on-edit version: every save lands a
-- row here, and future Ennie integrations can compute deltas (phrases
-- added, phrases dropped, structural changes) to feed her drafting context.
--
-- Today: no consumer reads this table. The infrastructure is laid so the
-- learning loop can be turned on without an additional migration when
-- (a) lifecycle gets Ennie-drafted bodies, or (b) marketing-draft-campaign
-- starts reading lifecycle edits as voice signal for promo drafts.
--
-- Append-only by design — no UPDATE/DELETE policies, no GRANT for UPDATE
-- or DELETE. History is the audit trail.

CREATE TABLE IF NOT EXISTS automation_edits (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id       uuid        NOT NULL REFERENCES automation_templates(id) ON DELETE CASCADE,
  field             text        NOT NULL,
  previous_value    text,
  new_value         text,
  edited_by         uuid        REFERENCES auth.users(id),
  edited_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT automation_edits_field_check CHECK (field IN (
    'subject_override', 'body_override', 'timing_override', 'enabled'
  ))
);

CREATE INDEX IF NOT EXISTS automation_edits_by_org_template_idx
  ON automation_edits (organization_id, template_id, edited_at DESC);

CREATE INDEX IF NOT EXISTS automation_edits_recent_idx
  ON automation_edits (edited_at DESC);

GRANT SELECT, INSERT ON automation_edits TO authenticated;

ALTER TABLE automation_edits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS members_read_automation_edits ON automation_edits;
CREATE POLICY members_read_automation_edits
  ON automation_edits
  FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());

DROP POLICY IF EXISTS members_write_automation_edits ON automation_edits;
CREATE POLICY members_write_automation_edits
  ON automation_edits
  FOR INSERT
  WITH CHECK (is_org_member(organization_id) OR is_platform_admin());

COMMENT ON TABLE automation_edits IS
  'Append-only voice-signal history. Every operator save of an automation override appends a row. Future Ennie integration computes deltas (phrases added/dropped, structural changes) to feed her drafting context. Companion to organizations.brand_voice (static prefs); this captures dynamic, behavior-derived prefs.';

COMMENT ON COLUMN automation_edits.field IS
  'Which override changed: subject_override, body_override, timing_override, or enabled. One row per field per save.';

COMMENT ON COLUMN automation_edits.previous_value IS
  'Stringified prior value (or null if first save). Stored so a future learner can compute the diff without re-fetching history.';
