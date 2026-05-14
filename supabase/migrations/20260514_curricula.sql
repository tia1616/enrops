-- curricula — curriculum-level entity (templates that get scheduled into
-- programs rows later). Created as a separate table from `programs` because
-- the existing `programs` table holds scheduled offerings (1 row per program
-- at-location at-term), not curriculum templates.
-- Run date: 2026-05-14

CREATE TABLE IF NOT EXISTS curricula (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  short_description TEXT,
  age_min INTEGER,
  age_max INTEGER,
  session_count INTEGER,
  format TEXT CHECK (format IN ('afterschool', 'summer_camp', 'other')),
  narrative_arc TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'extracted', 'published')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curricula_age_range_valid CHECK (age_min IS NULL OR age_max IS NULL OR age_min <= age_max)
);

CREATE INDEX IF NOT EXISTS curricula_organization_id_idx ON curricula(organization_id);
CREATE INDEX IF NOT EXISTS curricula_status_idx ON curricula(status);

ALTER TABLE curricula ENABLE ROW LEVEL SECURITY;

-- Mirror the camp_assignments RLS pattern: org members can read, admins/owners write.
CREATE POLICY "org_members_read_curricula" ON curricula
  FOR SELECT USING (
    organization_id IN (
      SELECT organization_id FROM org_members WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY "org_admins_write_curricula" ON curricula
  FOR ALL USING (
    organization_id IN (
      SELECT organization_id FROM org_members
      WHERE auth_user_id = auth.uid()
      AND role = ANY(ARRAY['owner', 'admin'])
    )
  );
