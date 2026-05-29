-- 20260529_program_curriculum_changes.sql
--
-- Audit log for curriculum swaps on scheduled programs. One row per save
-- from EditProgramCurriculumModal — captures who changed it, when, from
-- which curriculum to which, and which notifications fired (or didn't).
--
-- Shape mirrors roster_email_sends: org-scoped, RLS-read for org members,
-- writes only via service-role edge function. Recipients are stored as
-- JSONB snapshots so the row stays honest even if a parent/instructor
-- record is later edited or deleted.
--
-- Why both from_curriculum_id AND from_curriculum_name (and same for to_):
-- the curricula table is mutable (names can be edited, rows can be soft-
-- deleted), but the audit record needs to read truthfully years later.
-- The FK is for joins/analytics; the text is the historical snapshot.

CREATE TABLE IF NOT EXISTS program_curriculum_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  program_id UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  changed_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- From/to snapshots. from_* may be NULL if the program had no curriculum
  -- previously assigned. to_* is required (you can't save a no-op).
  from_curriculum_id UUID,
  from_curriculum_name TEXT,
  to_curriculum_id UUID NOT NULL,
  to_curriculum_name TEXT NOT NULL,

  -- Per-channel operator decision. 'no_recipients' means the channel was
  -- never offered because there was nobody to notify (zero enrolled
  -- families, or no confirmed instructor who'd already been emailed).
  family_notify_choice TEXT NOT NULL
    CHECK (family_notify_choice IN ('sent', 'skipped', 'no_recipients')),
  instructor_notify_choice TEXT NOT NULL
    CHECK (instructor_notify_choice IN ('sent', 'skipped', 'no_recipient')),

  -- Family-send results. One entry per parent we attempted to email.
  -- Shape: [{ "parent_id": uuid, "name": "Jane Doe", "email": "...",
  --           "resend_message_id": "...", "status": "sent"|"failed",
  --           "failure_reason": "..." }]
  -- Empty array when family_notify_choice = 'skipped' or 'no_recipients'.
  family_recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  family_sent_count INTEGER NOT NULL DEFAULT 0,
  family_failed_count INTEGER NOT NULL DEFAULT 0,

  -- Instructor-send result. Singleton (programs have at most one confirmed
  -- instructor at change time). Shape:
  --   { "instructor_id": uuid, "name": "...", "email": "...",
  --     "resend_message_id": "...", "status": "sent"|"failed",
  --     "failure_reason": "..." }
  -- NULL when instructor_notify_choice = 'skipped' or 'no_recipient'.
  instructor_recipient JSONB,

  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_program_curriculum_changes_organization_id
  ON program_curriculum_changes(organization_id);
CREATE INDEX IF NOT EXISTS idx_program_curriculum_changes_program_id
  ON program_curriculum_changes(program_id);
-- Supports "last changed N days ago" lookups in the program detail UI.
CREATE INDEX IF NOT EXISTS idx_program_curriculum_changes_program_recent
  ON program_curriculum_changes(program_id, changed_at DESC);

COMMENT ON TABLE  program_curriculum_changes IS 'Audit of curriculum swaps on scheduled programs. One row per EditProgramCurriculumModal save, including notification fan-out results.';
COMMENT ON COLUMN program_curriculum_changes.from_curriculum_name IS 'Snapshot of curricula.name at change time. Reads truthfully even if curricula row is later renamed or deleted.';
COMMENT ON COLUMN program_curriculum_changes.family_recipients IS 'Per-parent send results. Each item: { parent_id, name, email, resend_message_id, status, failure_reason }.';
COMMENT ON COLUMN program_curriculum_changes.instructor_recipient IS 'Single instructor send result, or NULL when skipped/no eligible instructor.';

ALTER TABLE program_curriculum_changes ENABLE ROW LEVEL SECURITY;

-- Org members can read their org's change history. Writes happen via the
-- edge function with the service-role key, so no INSERT/UPDATE/DELETE
-- policy is needed for authenticated users — these rows are immutable
-- audit artifacts.
CREATE POLICY program_curriculum_changes_org_read
  ON program_curriculum_changes
  FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());

-- Per the project's 2026-10-30 migration rule: explicit grants on new
-- public tables. RLS still gates row visibility.
GRANT SELECT ON program_curriculum_changes TO authenticated;
-- INSERTs come from the edge function via service role; no anon access.
