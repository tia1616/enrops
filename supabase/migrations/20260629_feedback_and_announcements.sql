-- 20260629_feedback_and_announcements.sql
--
-- Two net-new tables for the early-adopter feedback surface (launch-gating
-- Tier-1 item per project_enrops_arielle_feedback_batch) + the data-driven
-- announcement banner.
--
--   1. feedback               — in-app free-text feedback from any logged-in
--                               user. INSERT gated to org members (WITH CHECK);
--                               SELECT restricted to platform admins. The
--                               reach-Jessica path is an email from the
--                               submit-feedback edge fn; this table is the
--                               durable record + future dashboard source.
--   2. platform_announcements — global (Enrops -> all tenants) announcement
--                               banner content. Platform-admin writes; all
--                               authenticated users read active rows. Banner
--                               dismissal is client-side (localStorage by id),
--                               so there is no per-user dismissal table.
--
-- RLS uses the project-standard helpers is_org_member(uuid) /
-- is_platform_admin() copied verbatim from the automations policies per the
-- feedback-parallel-schema-match-existing rule. New public tables need
-- explicit GRANTs (project_enrops_supabase_migrations).

-- ============================================================================
-- 1. feedback
-- ============================================================================
CREATE TABLE IF NOT EXISTS feedback (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  auth_user_id      uuid        NOT NULL DEFAULT auth.uid(),
  user_email        text,
  message           text        NOT NULL,
  page_url          text,
  page_path         text,
  user_agent        text,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT feedback_message_not_blank CHECK (length(btrim(message)) > 0),
  CONSTRAINT feedback_message_max_len   CHECK (length(message) <= 5000)
);

CREATE INDEX IF NOT EXISTS feedback_by_org_idx
  ON feedback (organization_id, created_at DESC);

-- ============================================================================
-- 2. platform_announcements
-- ============================================================================
CREATE TABLE IF NOT EXISTS platform_announcements (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text        NOT NULL,
  body         text        NOT NULL,
  cta_label    text,
  cta_url      text,
  variant      text        NOT NULL DEFAULT 'info',
  active       boolean     NOT NULL DEFAULT true,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT platform_announcements_variant_check CHECK (variant IN ('info','success','warning')),
  -- a button label and its url travel together or not at all
  CONSTRAINT platform_announcements_cta_paired CHECK (
    (cta_label IS NULL AND cta_url IS NULL) OR
    (cta_label IS NOT NULL AND cta_url IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS platform_announcements_active_idx
  ON platform_announcements (active, created_at DESC) WHERE active = true;

-- ============================================================================
-- GRANTs
-- ============================================================================
-- feedback: any logged-in user may file (RLS WITH CHECK limits to their own
-- org + their own uid); SELECT is gated by RLS to platform admins only.
-- No UPDATE/DELETE granted -- feedback is an immutable record.
GRANT SELECT, INSERT ON feedback TO authenticated;

-- platform_announcements: all authenticated users read (RLS shows active rows);
-- all writes gated by RLS to platform admins.
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_announcements TO authenticated;

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- INSERT is granted directly to authenticated (not just the edge fn), so the
-- WITH CHECK must pin BOTH identity columns to the caller's JWT — otherwise a
-- member could POST to /rest/v1/feedback with a forged user_email and poison
-- the record the platform dashboard trusts.
DROP POLICY IF EXISTS members_insert_feedback ON feedback;
CREATE POLICY members_insert_feedback
  ON feedback
  FOR INSERT
  WITH CHECK (
    is_org_member(organization_id)
    AND auth_user_id = auth.uid()
    AND (user_email IS NULL OR user_email = auth.email())
  );

DROP POLICY IF EXISTS platform_admin_read_feedback ON feedback;
CREATE POLICY platform_admin_read_feedback
  ON feedback
  FOR SELECT
  USING (is_platform_admin());

ALTER TABLE platform_announcements ENABLE ROW LEVEL SECURITY;

-- everyone logged in sees ACTIVE announcements; platform admins also see drafts
DROP POLICY IF EXISTS read_active_announcements ON platform_announcements;
CREATE POLICY read_active_announcements
  ON platform_announcements
  FOR SELECT
  USING (active = true OR is_platform_admin());

-- only platform admins create / edit / retire announcements
DROP POLICY IF EXISTS platform_admin_write_announcements ON platform_announcements;
CREATE POLICY platform_admin_write_announcements
  ON platform_announcements
  FOR ALL
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());

-- ============================================================================
-- Comments
-- ============================================================================
COMMENT ON TABLE feedback IS
  'In-app early-adopter feedback. Written by the submit-feedback edge fn under the user JWT (RLS applies). The notify path is an email to the platform support address; this table is the durable record + future dashboard source.';

COMMENT ON TABLE platform_announcements IS
  'Global Enrops->all-tenants announcement banner content. Platform-admin authored. Banner shows latest active row; dismissal is client-side (localStorage by id).';

COMMENT ON COLUMN platform_announcements.variant IS
  'Banner tone: info (default) / success / warning. Drives styling only.';
