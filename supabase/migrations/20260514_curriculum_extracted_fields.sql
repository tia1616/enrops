-- curriculum_extracted_fields — per-field extraction output from the AI,
-- one row per (curriculum, field_name). Holds the raw AI value + confidence
-- plus the human-approved/edited value once the provider reviews it in
-- Chunk 3's review screen.
-- Run date: 2026-05-14

CREATE TABLE IF NOT EXISTS curriculum_extracted_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_id UUID NOT NULL REFERENCES curricula(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  field_name TEXT NOT NULL,
  extracted_value JSONB,
  confidence FLOAT CHECK (confidence >= 0 AND confidence <= 1),
  source_document_id UUID REFERENCES curriculum_documents(id) ON DELETE SET NULL,
  human_approved BOOLEAN NOT NULL DEFAULT false,
  human_edited_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (curriculum_id, field_name)
);

CREATE INDEX IF NOT EXISTS curriculum_extracted_fields_curriculum_idx ON curriculum_extracted_fields(curriculum_id);
CREATE INDEX IF NOT EXISTS curriculum_extracted_fields_organization_idx ON curriculum_extracted_fields(organization_id);

ALTER TABLE curriculum_extracted_fields ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_members_read_curriculum_extracted_fields" ON curriculum_extracted_fields
  FOR SELECT USING (
    organization_id IN (
      SELECT organization_id FROM org_members WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY "org_admins_write_curriculum_extracted_fields" ON curriculum_extracted_fields
  FOR ALL USING (
    organization_id IN (
      SELECT organization_id FROM org_members
      WHERE auth_user_id = auth.uid()
      AND role = ANY(ARRAY['owner', 'admin'])
    )
  );
