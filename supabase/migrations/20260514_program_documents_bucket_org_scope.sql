-- Widen program-documents bucket RLS so org admins can read/write within their
-- org's path. Chunk 2 path pattern: `<organization_id>/<curriculum_id>/<doc_id>-<filename>`.
-- The first path segment is the org_id, which we match against the caller's
-- org_members rows.
--
-- The existing platform_admin policies (from Chunk 1 dev tool) are left in
-- place — Postgres ORs policies, so platform admins keep full access AND org
-- admins get scoped access for production uploads.
-- Run date: 2026-05-14

CREATE POLICY "program_documents_org_admin_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'program-documents'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT organization_id FROM org_members
      WHERE auth_user_id = auth.uid()
      AND role = ANY(ARRAY['owner', 'admin'])
    )
  );

CREATE POLICY "program_documents_org_admin_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'program-documents'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT organization_id FROM org_members
      WHERE auth_user_id = auth.uid()
      AND role = ANY(ARRAY['owner', 'admin'])
    )
  );

CREATE POLICY "program_documents_org_admin_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'program-documents'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT organization_id FROM org_members
      WHERE auth_user_id = auth.uid()
      AND role = ANY(ARRAY['owner', 'admin'])
    )
  );
