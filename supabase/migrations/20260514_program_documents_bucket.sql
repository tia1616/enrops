-- program-documents Storage bucket
-- Run date: 2026-05-14
--
-- Private bucket for curriculum documents uploaded via /admin/dev/extraction-test
-- (and, in Chunk 2, the production Programs onboarding flow). Files live at
-- <auth_user_id>/<timestamp>-<filename>. Access is gated by is_platform_admin()
-- in v1. When Chunk 2 lands and tenant staff start uploading, the policy will
-- be widened to also include org_members of the file's owning organization.

INSERT INTO storage.buckets (id, name, public)
VALUES ('program-documents', 'program-documents', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "program_documents_admin_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'program-documents' AND is_platform_admin());

CREATE POLICY "program_documents_admin_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'program-documents' AND is_platform_admin());

CREATE POLICY "program_documents_admin_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'program-documents' AND is_platform_admin());
