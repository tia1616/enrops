-- curriculum_documents — instructor guides, materials lists, student materials
-- attached to a curriculum. Files live in the `program-documents` Storage
-- bucket; drive_url rows reference Google Docs/Drive links.
-- Run date: 2026-05-14

CREATE TABLE IF NOT EXISTS curriculum_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_id UUID NOT NULL REFERENCES curricula(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('instructor_guide', 'materials_list', 'student_materials', 'other')),
  source_type TEXT NOT NULL CHECK (source_type IN ('upload', 'drive_link')),
  storage_path TEXT,
  drive_url TEXT,
  original_filename TEXT,
  mime_type TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  extraction_status TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending', 'processing', 'complete', 'failed')),
  extraction_result JSONB,
  extraction_error TEXT,
  CONSTRAINT curriculum_documents_source_check CHECK (
    (source_type = 'upload' AND storage_path IS NOT NULL) OR
    (source_type = 'drive_link' AND drive_url IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS curriculum_documents_curriculum_id_idx ON curriculum_documents(curriculum_id);
CREATE INDEX IF NOT EXISTS curriculum_documents_organization_id_idx ON curriculum_documents(organization_id);
CREATE INDEX IF NOT EXISTS curriculum_documents_extraction_status_idx ON curriculum_documents(extraction_status);

ALTER TABLE curriculum_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_members_read_curriculum_documents" ON curriculum_documents
  FOR SELECT USING (
    organization_id IN (
      SELECT organization_id FROM org_members WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY "org_admins_write_curriculum_documents" ON curriculum_documents
  FOR ALL USING (
    organization_id IN (
      SELECT organization_id FROM org_members
      WHERE auth_user_id = auth.uid()
      AND role = ANY(ARRAY['owner', 'admin'])
    )
  );
