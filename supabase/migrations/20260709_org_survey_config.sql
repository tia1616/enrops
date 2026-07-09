-- Per-org, per-context availability-survey configuration (v1 = "toggles + intro").
-- Lets an operator turn standard survey questions on/off and set a default intro,
-- without a full form builder. Data-derived questions (areas, subjects) keep their
-- OPTIONS sourced from Programs/Curricula — the toggle only controls whether the
-- whole question is asked.
--
-- Additive + empty-default: no row (or an empty disabled_questions array) means
-- every standard question is asked — i.e. today's behavior. The survey forms read
-- this to hide toggled-off questions; the matcher already treats an absent
-- dimension as neutral, so hiding a question degrades gracefully.
--
-- context: 'afterschool' | 'camp'. RLS mirrors afterschool_survey_state exactly:
-- org admins write, org members read (Settings), instructors read (survey form).
--
-- Applied to staging (mumfymlapolsfdnpewci) 2026-07-09 via MCP; apply to prod
-- (iuasfpztkmrtagivlhtj) in the same pass on ship.
CREATE TABLE IF NOT EXISTS public.org_survey_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  context text NOT NULL CHECK (context IN ('afterschool','camp')),
  disabled_questions text[] NOT NULL DEFAULT '{}',
  intro text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, context)
);

COMMENT ON TABLE public.org_survey_config IS
  'Per-org availability-survey config (v1): which standard questions are turned off + a default intro, keyed by context (afterschool|camp). Empty/absent = all questions on.';
COMMENT ON COLUMN public.org_survey_config.disabled_questions IS
  'Standard question keys the operator turned OFF for this context. Empty = every question asked (default behavior).';

ALTER TABLE public.org_survey_config ENABLE ROW LEVEL SECURITY;

-- Org admins (owner/admin) write; platform admins too.
CREATE POLICY org_survey_config_org_write ON public.org_survey_config
  FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- Any org member reads (the Settings surface renders for admins/staff/viewers).
CREATE POLICY org_survey_config_org_read ON public.org_survey_config
  FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());

-- Instructors read their own org's config so the survey form can honor it.
CREATE POLICY org_survey_config_instructor_read ON public.org_survey_config
  FOR SELECT
  USING (organization_id IN (
    SELECT instructors.organization_id FROM public.instructors
    WHERE instructors.auth_user_id = auth.uid()
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_survey_config TO authenticated;
