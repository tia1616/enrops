-- Admin upload policy for the contractor-documents storage bucket.
-- Mirrors the existing org_admin_read_contractor_docs SELECT policy so an
-- owner/admin org_member can INSERT a file at any instructor path within
-- their organization. Required for feature A (admin BG-check upload UI).
--
-- Instructor's own upload policy is unchanged — instructors can still only
-- write to their own {instructor_id}/* path via instructor_upload_own_
-- contractor_docs.
--
-- Applied 2026-05-22 (already executed against project iuasfpztkmrtagivlhtj).

CREATE POLICY "org_admin_upload_contractor_docs"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'contractor-documents'
    AND ((storage.foldername(name))[1])::uuid IN (
      SELECT instructors.id
      FROM instructors
      WHERE instructors.organization_id IN (
        SELECT org_members.organization_id
        FROM org_members
        WHERE org_members.auth_user_id = auth.uid()
          AND org_members.role = ANY (ARRAY['owner'::text, 'admin'::text])
      )
    )
  );
