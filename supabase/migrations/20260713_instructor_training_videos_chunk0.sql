-- ============================================================================
-- Instructor Training Videos - Chunk 0 schema (additive, empty, inert)
-- Mirrors the per-tenant background-check toggle pattern.
-- Default OFF so every existing org (incl. J2S) is behaviorally unchanged.
-- ============================================================================

-- 1) Per-org opt-in config (mirror organizations.background_check_config; default OFF)
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS training_config jsonb NOT NULL DEFAULT '{"enabled": false}'::jsonb;

-- 2) Library of training videos (org-scoped)
CREATE TABLE IF NOT EXISTS public.instructor_training_videos (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  title                text NOT NULL,
  description          text,
  bucket_object_path   text,        -- path in the private training-videos bucket (v1)
  external_url         text,        -- future path B (Vimeo/Loom); NULL in v1
  duration_seconds     numeric,     -- captured server-side on upload; coverage math needs it
  version              integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  is_required          boolean NOT NULL DEFAULT true,
  completion_threshold numeric NOT NULL DEFAULT 0.95
                         CHECK (completion_threshold > 0 AND completion_threshold <= 1),
  quiz                 jsonb,       -- [{q, options:[...], correct_index}]; NULL = no quiz (watch-only gate)
  sort_order           integer NOT NULL DEFAULT 0,
  active               boolean NOT NULL DEFAULT true,
  created_by           uuid,        -- auth user id of the admin who created it
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT training_video_has_source CHECK (bucket_object_path IS NOT NULL OR external_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_training_videos_org ON public.instructor_training_videos(organization_id);

-- 3) Completion records (the audit artifact). SERVER-WRITE ONLY (no client write policies).
CREATE TABLE IF NOT EXISTS public.instructor_training_completions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  instructor_id        uuid NOT NULL REFERENCES public.instructors(id) ON DELETE CASCADE,
  training_video_id    uuid NOT NULL REFERENCES public.instructor_training_videos(id) ON DELETE CASCADE,
  video_version        integer NOT NULL DEFAULT 1,     -- version passed; grandfathers past completions
  max_position_seconds numeric NOT NULL DEFAULT 0,     -- furthest watched -> resume + coverage numerator
  coverage_pct         numeric NOT NULL DEFAULT 0 CHECK (coverage_pct >= 0 AND coverage_pct <= 1),
  watched_completed_at timestamptz,
  quiz_passed          boolean NOT NULL DEFAULT false,
  quiz_score           integer,
  quiz_attempts        integer NOT NULL DEFAULT 0,
  quiz_last_attempt_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_training_completion UNIQUE (instructor_id, training_video_id)
);
CREATE INDEX IF NOT EXISTS idx_training_completions_instructor ON public.instructor_training_completions(instructor_id);
CREATE INDEX IF NOT EXISTS idx_training_completions_video      ON public.instructor_training_completions(training_video_id);
CREATE INDEX IF NOT EXISTS idx_training_completions_org        ON public.instructor_training_completions(organization_id);

-- 4) RLS
ALTER TABLE public.instructor_training_videos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instructor_training_completions ENABLE ROW LEVEL SECURITY;

-- Videos: any org member reads; instructor reads active videos of their own org; owner/admin write.
CREATE POLICY training_videos_member_read ON public.instructor_training_videos
  FOR SELECT USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE POLICY training_videos_instructor_read ON public.instructor_training_videos
  FOR SELECT USING (
    active AND organization_id IN (
      SELECT i.organization_id FROM public.instructors i
      WHERE i.id = private.current_instructor_id()
    )
  );

CREATE POLICY training_videos_admin_write ON public.instructor_training_videos
  FOR ALL
  USING (
    public.is_platform_admin() OR organization_id IN (
      SELECT om.organization_id FROM public.org_members om
      WHERE om.auth_user_id = auth.uid() AND om.role IN ('owner','admin')
    )
  )
  WITH CHECK (
    public.is_platform_admin() OR organization_id IN (
      SELECT om.organization_id FROM public.org_members om
      WHERE om.auth_user_id = auth.uid() AND om.role IN ('owner','admin')
    )
  );

-- Completions: instructor reads own; org members read (the "who's trained" surface).
-- NO insert/update/delete policies -> only service_role (RLS-bypassing edge fns) can write.
CREATE POLICY training_completions_instructor_read ON public.instructor_training_completions
  FOR SELECT USING (instructor_id = private.current_instructor_id());

CREATE POLICY training_completions_member_read ON public.instructor_training_completions
  FOR SELECT USING (public.is_org_member(organization_id) OR public.is_platform_admin());

-- 5) Expose training_enabled on the instructor-facing public directory view
--    (instructors are NOT org_members; they read the wizard gate through this view).
--    Preserve every existing column exactly; append training_enabled.
CREATE OR REPLACE VIEW public.public_org_directory AS
  SELECT id, slug, name, logo_url, logo_email_url, status, timezone, active_registration_term,
    jsonb_build_object(
      'enabled',       COALESCE((background_check_config ->> 'enabled')::boolean, true),
      'provider_name', background_check_config ->> 'provider_name',
      'provider_url',  background_check_config ->> 'provider_url',
      'instructions',  background_check_config ->> 'instructions'
    ) AS background_check_public,
    COALESCE((training_config ->> 'enabled')::boolean, false) AS training_enabled
  FROM organizations
  WHERE status = 'active';

GRANT SELECT ON public.public_org_directory TO anon, authenticated;

-- 6) Private training-videos bucket (org-id folder isolation; web-safe formats; 1 GB cap)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('training-videos', 'training-videos', false, 1073741824, ARRAY['video/mp4','video/webm'])
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: owner/admin manage their own org folder. Instructors get files via a
-- service-role signed-URL edge fn (get-training-video-url), so no instructor storage policy.
CREATE POLICY training_videos_admin_read ON storage.objects
  FOR SELECT USING (
    bucket_id = 'training-videos' AND (
      public.is_platform_admin() OR ((storage.foldername(name))[1])::uuid IN (
        SELECT om.organization_id FROM public.org_members om
        WHERE om.auth_user_id = auth.uid() AND om.role IN ('owner','admin')
      )
    )
  );

CREATE POLICY training_videos_admin_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'training-videos' AND ((storage.foldername(name))[1])::uuid IN (
      SELECT om.organization_id FROM public.org_members om
      WHERE om.auth_user_id = auth.uid() AND om.role IN ('owner','admin')
    )
  );

CREATE POLICY training_videos_admin_update ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'training-videos' AND ((storage.foldername(name))[1])::uuid IN (
      SELECT om.organization_id FROM public.org_members om
      WHERE om.auth_user_id = auth.uid() AND om.role IN ('owner','admin')
    )
  )
  WITH CHECK (
    bucket_id = 'training-videos' AND ((storage.foldername(name))[1])::uuid IN (
      SELECT om.organization_id FROM public.org_members om
      WHERE om.auth_user_id = auth.uid() AND om.role IN ('owner','admin')
    )
  );

CREATE POLICY training_videos_admin_delete ON storage.objects
  FOR DELETE USING (
    bucket_id = 'training-videos' AND ((storage.foldername(name))[1])::uuid IN (
      SELECT om.organization_id FROM public.org_members om
      WHERE om.auth_user_id = auth.uid() AND om.role IN ('owner','admin')
    )
  );
