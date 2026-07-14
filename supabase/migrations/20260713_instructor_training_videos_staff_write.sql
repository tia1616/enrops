-- ============================================================================
-- Instructor Training Videos - allow STAFF (not just owner/admin) to manage the
-- library. Swap the hardcoded owner/admin role checks for the single-source RBAC
-- helper can_edit_org() (= owner | admin | staff). Library mgmt is operational,
-- not money-gated. Read/write of completions is unchanged (still server-only).
-- ============================================================================

-- Videos table: editors (owner/admin/staff) write.
DROP POLICY IF EXISTS training_videos_admin_write ON public.instructor_training_videos;
CREATE POLICY training_videos_editor_write ON public.instructor_training_videos
  FOR ALL
  USING      (public.is_platform_admin() OR public.can_edit_org(organization_id))
  WITH CHECK (public.is_platform_admin() OR public.can_edit_org(organization_id));

-- Storage bucket: editors manage their own org folder.
DROP POLICY IF EXISTS training_videos_admin_read ON storage.objects;
CREATE POLICY training_videos_editor_read ON storage.objects
  FOR SELECT USING (
    bucket_id = 'training-videos' AND (
      public.is_platform_admin()
      OR public.can_edit_org(((storage.foldername(name))[1])::uuid)
    )
  );

DROP POLICY IF EXISTS training_videos_admin_insert ON storage.objects;
CREATE POLICY training_videos_editor_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'training-videos'
    AND public.can_edit_org(((storage.foldername(name))[1])::uuid)
  );

DROP POLICY IF EXISTS training_videos_admin_update ON storage.objects;
CREATE POLICY training_videos_editor_update ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'training-videos'
    AND public.can_edit_org(((storage.foldername(name))[1])::uuid)
  )
  WITH CHECK (
    bucket_id = 'training-videos'
    AND public.can_edit_org(((storage.foldername(name))[1])::uuid)
  );

DROP POLICY IF EXISTS training_videos_admin_delete ON storage.objects;
CREATE POLICY training_videos_editor_delete ON storage.objects
  FOR DELETE USING (
    bucket_id = 'training-videos'
    AND public.can_edit_org(((storage.foldername(name))[1])::uuid)
  );
