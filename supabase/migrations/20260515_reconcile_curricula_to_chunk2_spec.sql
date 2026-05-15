-- Reconcile yesterday's Chunk 2 work with the new (rewritten) Chunk 2 spec.
-- Run date: 2026-05-15
--
-- Yesterday created `curricula`, `curriculum_to_locations`, `curriculum_documents`,
-- and `curriculum_extracted_fields` based on the original spec (5-step UI flow,
-- M:N curriculum→locations). The rewritten spec is upload-first, has many more
-- curriculum fields, splits sessions into their own table, and treats locations
-- as program-level (not curriculum-level) because the same curriculum runs at
-- multiple locations under different program rows.
--
-- All 4 tables are empty (verified before this migration) so column renames and
-- table drops are safe.
--
-- Changes:
--   1. DROP curriculum_to_locations (wrong model — locations live on programs)
--   2. ALTER curricula: rename age_min/max → age_range_min/max, add 8 new columns
--      (session_types_supported, themes, skills_overall, materials,
--      instructor_guide_notes, created_by, grade_min, grade_max). narrative_arc
--      already exists from yesterday.
--   3. ALTER curriculum_documents ADD extracted_text (for Drive imports
--      snapshotting content)
--   4. CREATE curriculum_sessions (per-session data — recap_template, etc.)
--   5. ALTER programs ADD curriculum_id (FK linking each scheduled program to
--      its curriculum)
--   6. CREATE curriculum-documents Storage bucket + RLS (replaces the
--      `program-documents` bucket for production use; program-documents bucket
--      stays as orphan for yesterday's dev test files).

-- ============================================================
-- 1. Drop curriculum_to_locations
-- ============================================================
DROP TABLE IF EXISTS curriculum_to_locations;

-- ============================================================
-- 2. Reshape curricula
-- ============================================================
ALTER TABLE curricula RENAME COLUMN age_min TO age_range_min;
ALTER TABLE curricula RENAME COLUMN age_max TO age_range_max;

-- The existing age_range_valid check still works with the renamed columns.

ALTER TABLE curricula
  ADD COLUMN IF NOT EXISTS session_types_supported TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS themes TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS skills_overall TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS materials TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS instructor_guide_notes TEXT,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS grade_min INTEGER,
  ADD COLUMN IF NOT EXISTS grade_max INTEGER;

ALTER TABLE curricula
  ADD CONSTRAINT curricula_grade_range_valid CHECK (grade_min IS NULL OR grade_max IS NULL OR grade_min <= grade_max);

-- ============================================================
-- 3. extracted_text on curriculum_documents (for Drive snapshots)
-- ============================================================
ALTER TABLE curriculum_documents
  ADD COLUMN IF NOT EXISTS extracted_text TEXT;

-- ============================================================
-- 4. curriculum_sessions table (per-session content)
-- ============================================================
CREATE TABLE IF NOT EXISTS curriculum_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_id UUID NOT NULL REFERENCES curricula(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id),

  session_number INTEGER NOT NULL,
  title TEXT,
  description TEXT,
  skills_practiced TEXT[] NOT NULL DEFAULT '{}',
  materials_session TEXT[] NOT NULL DEFAULT '{}',
  recap_template TEXT,
  parent_engagement_question TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (curriculum_id, session_number)
);

CREATE INDEX IF NOT EXISTS curriculum_sessions_curriculum_id_idx ON curriculum_sessions(curriculum_id);
CREATE INDEX IF NOT EXISTS curriculum_sessions_organization_id_idx ON curriculum_sessions(organization_id);

ALTER TABLE curriculum_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_members_read_curriculum_sessions" ON curriculum_sessions
  FOR SELECT USING (
    organization_id IN (
      SELECT organization_id FROM org_members WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY "org_admins_write_curriculum_sessions" ON curriculum_sessions
  FOR ALL USING (
    organization_id IN (
      SELECT organization_id FROM org_members
      WHERE auth_user_id = auth.uid()
      AND role = ANY(ARRAY['owner', 'admin'])
    )
  );

-- ============================================================
-- 5. programs.curriculum_id FK
-- ============================================================
ALTER TABLE programs
  ADD COLUMN IF NOT EXISTS curriculum_id UUID REFERENCES curricula(id);

CREATE INDEX IF NOT EXISTS programs_curriculum_id_idx ON programs(curriculum_id);

-- Nullable for now — existing 90 programs rows will be backfilled by the
-- scripts/backfill-curricula.ts script (per the spec, NOT auto-run here).

-- ============================================================
-- 6. curriculum-documents Storage bucket (new)
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('curriculum-documents', 'curriculum-documents', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "curriculum_documents_org_admin_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'curriculum-documents'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT organization_id FROM org_members
      WHERE auth_user_id = auth.uid()
      AND role = ANY(ARRAY['owner', 'admin'])
    )
  );

CREATE POLICY "curriculum_documents_org_admin_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'curriculum-documents'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT organization_id FROM org_members
      WHERE auth_user_id = auth.uid()
      AND role = ANY(ARRAY['owner', 'admin'])
    )
  );

CREATE POLICY "curriculum_documents_org_admin_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'curriculum-documents'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT organization_id FROM org_members
      WHERE auth_user_id = auth.uid()
      AND role = ANY(ARRAY['owner', 'admin'])
    )
  );

CREATE POLICY "curriculum_documents_platform_admin_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'curriculum-documents'
    AND is_platform_admin()
  );

CREATE POLICY "curriculum_documents_platform_admin_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'curriculum-documents'
    AND is_platform_admin()
  );

CREATE POLICY "curriculum_documents_platform_admin_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'curriculum-documents'
    AND is_platform_admin()
  );
