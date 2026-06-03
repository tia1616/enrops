-- 20260603_automation_tables.sql
--
-- Automations (lifecycle informational comms) — Family Comms sub-tab.
--
-- Three tables:
--   1. automation_templates  — system rows, one per workflow (global read)
--   2. automations           — per-org overrides + enabled toggle (RLS-scoped)
--   3. automation_runs       — audit log per cron fire (artifact column source
--                              of truth for "last fired" — automations row
--                              does NOT denormalize last_fired_at per the
--                              feedback-ui-state-artifacts rule)
--
-- RLS uses the project-standard helpers is_org_member(uuid) and
-- is_platform_admin() — copied verbatim from programs/marketing_campaigns
-- policies per feedback-parallel-schema-match-existing.
--
-- All v1 templates are mailing_type='informational' — they bypass the
-- promotional-unsubscribe filter in marketing-touchpoint-send. Marketing
-- (promotional) campaigns continue to respect unsubscribes via the existing
-- AI campaign pipeline.

-- ============================================================================
-- 1. automation_templates  (system rows, global read)
-- ============================================================================
CREATE TABLE IF NOT EXISTS automation_templates (
  id                            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key                           text        NOT NULL UNIQUE,
  display_name                  text        NOT NULL,
  description                   text        NOT NULL,
  trigger_type                  text        NOT NULL,
  applies_to_program_type       text        NOT NULL,
  mailing_type                  text        NOT NULL,
  default_subject               text        NOT NULL,
  default_body                  text        NOT NULL,
  default_timing                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  time_saved_minutes_per_send   integer     NOT NULL DEFAULT 3,
  push_to_parent_portal         boolean     NOT NULL DEFAULT true,
  is_v1_enabled                 boolean     NOT NULL DEFAULT true,
  sort_order                    integer     NOT NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT automation_templates_trigger_type_check CHECK (trigger_type IN (
    'event_registration_confirmed',
    'days_before_first_session',
    'days_after_first_session',
    'session_midpoint',
    'session_last_day',
    'birthday',
    'event_registration_abandoned',
    'survey_pending'
  )),

  CONSTRAINT automation_templates_applies_to_check CHECK (applies_to_program_type IN (
    'camps', 'afterschool', 'both'
  )),

  CONSTRAINT automation_templates_mailing_type_check CHECK (mailing_type IN (
    'informational', 'marketing'
  )),

  CONSTRAINT automation_templates_time_saved_nonneg CHECK (time_saved_minutes_per_send >= 0)
);

CREATE INDEX IF NOT EXISTS automation_templates_sort_idx
  ON automation_templates (sort_order, key);


-- ============================================================================
-- 2. automations  (per-org overrides + enabled toggle)
-- ============================================================================
CREATE TABLE IF NOT EXISTS automations (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id         uuid        NOT NULL REFERENCES automation_templates(id) ON DELETE CASCADE,
  enabled             boolean     NOT NULL DEFAULT false,
  subject_override    text,
  body_override       text,
  timing_override     jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT automations_one_per_org_per_template UNIQUE (organization_id, template_id)
);

CREATE INDEX IF NOT EXISTS automations_enabled_lookup_idx
  ON automations (enabled, template_id) WHERE enabled = true;

-- updated_at trigger (function scoped to this table to avoid collisions)
CREATE OR REPLACE FUNCTION set_automations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS automations_set_updated_at ON automations;
CREATE TRIGGER automations_set_updated_at
  BEFORE UPDATE ON automations
  FOR EACH ROW
  EXECUTE FUNCTION set_automations_updated_at();


-- ============================================================================
-- 3. automation_runs  (audit log — artifact column source for "last fired")
-- ============================================================================
CREATE TABLE IF NOT EXISTS automation_runs (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id          uuid        NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  organization_id        uuid        NOT NULL,  -- denormalized for RLS perf
  fired_at               timestamptz NOT NULL DEFAULT now(),
  audience_size          integer     NOT NULL,
  status                 text        NOT NULL,
  error_message          text,
  marketing_send_ids     uuid[],
  time_saved_minutes     integer,
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT automation_runs_status_check CHECK (status IN (
    'queued',
    'sending',
    'sent',
    'failed',
    'skipped_no_audience',
    'skipped_disabled',
    'skipped_locked'
  )),

  CONSTRAINT automation_runs_audience_size_nonneg CHECK (audience_size >= 0),
  CONSTRAINT automation_runs_time_saved_nonneg     CHECK (time_saved_minutes IS NULL OR time_saved_minutes >= 0)
);

CREATE INDEX IF NOT EXISTS automation_runs_by_automation_idx
  ON automation_runs (automation_id, fired_at DESC);

CREATE INDEX IF NOT EXISTS automation_runs_by_org_idx
  ON automation_runs (organization_id, fired_at DESC);


-- ============================================================================
-- GRANTs  (per feedback-claude-runs-supabase + project_enrops_supabase_migrations:
-- new public tables created 2026-10-30 onward need explicit GRANTs)
-- ============================================================================

-- automation_templates: read-only for all authenticated users (system data)
GRANT SELECT ON automation_templates TO authenticated, anon;

-- automations: org members read+write their own org's rows (RLS filters)
GRANT SELECT, INSERT, UPDATE ON automations TO authenticated;

-- automation_runs: org members read their own org's rows; only service-role writes
GRANT SELECT ON automation_runs TO authenticated;

-- (No DELETE granted anywhere — automation rows persist; audit history persists.)


-- ============================================================================
-- RLS policies  (using project-standard helpers — parallel-schema rule)
-- ============================================================================

-- automation_templates: public read (global system rows)
ALTER TABLE automation_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS public_read_automation_templates ON automation_templates;
CREATE POLICY public_read_automation_templates
  ON automation_templates
  FOR SELECT
  USING (true);

-- automations: org members manage their org's rows (mirrors programs.members_manage_programs)
ALTER TABLE automations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS members_manage_automations ON automations;
CREATE POLICY members_manage_automations
  ON automations
  FOR ALL
  USING (is_org_member(organization_id) OR is_platform_admin())
  WITH CHECK (is_org_member(organization_id) OR is_platform_admin());

-- automation_runs: org members read their org's audit log (write is service-role only)
ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS members_read_automation_runs ON automation_runs;
CREATE POLICY members_read_automation_runs
  ON automation_runs
  FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());


-- ============================================================================
-- Comments (operator-facing context for future maintainers)
-- ============================================================================
COMMENT ON TABLE automation_templates IS
  'System templates for lifecycle automations (Welcome, Thank-you, etc.). Seeded by migration; not operator-editable. Per-org overrides live in the automations table.';

COMMENT ON TABLE automations IS
  'Per-org enablement + body/subject/timing overrides for automation_templates. enabled defaults false — operator opts in explicitly.';

COMMENT ON TABLE automation_runs IS
  'Audit log per cron fire. Source of truth for "last fired" pill (read via MAX(fired_at) — NOT denormalized to automations.last_fired_at per the artifact-column rule).';

COMMENT ON COLUMN automation_templates.mailing_type IS
  'informational = bypasses promotional-unsubscribe; marketing = respects it. All v1 templates are informational.';

COMMENT ON COLUMN automation_templates.push_to_parent_portal IS
  'Data trail flag — when the parent portal ships, it will read automation_runs with this=true. UI does not surface "parent portal" copy until the portal exists.';
