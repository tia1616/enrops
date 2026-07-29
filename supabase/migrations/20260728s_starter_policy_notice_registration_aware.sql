-- starter_policy_notice(): also report whether this tenant actually runs
-- registration through Enrops.
--
-- THE BUG THIS FIXES (caught in code review, 2026-07-28, before prod). The
-- notice told every operator, as a statement of fact:
--
--   "Families read this on the payment step before they pay."
--   "your registration form also includes N waivers families sign"
--
-- Neither is true for a tenant with uses_enrops_registration = false. They have
-- no Enrops checkout and no Enrops registration form. On prod that is TWO of the
-- four real prospects - Mrs. Richelle and Shoreview Chess - both of whom have a
-- published cancellation policy. A consent notice that misstates where the
-- promise appears is the same failure it was written to fix.
--
-- What IS true for them is unchanged and still worth telling them: the policy is
-- published under their business name and any family can read it at
-- /{slug}/cancellation. So the notice is still owed; only the wording moves.
--
-- The flag is returned from the DATABASE rather than read from the browser's
-- `org` context, so the sentence and the fact it depends on come from one place.
-- NULL means "not answered yet", which the whole app treats as true (see
-- AdminLayout's `org?.uses_enrops_registration !== false`), so coalesce here
-- matches that rather than inventing a third behaviour.

CREATE OR REPLACE FUNCTION public.starter_policy_notice(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row       public.org_policies%ROWTYPE;
  v_acked     boolean;
  v_waivers   int;
  v_slug      text;
  v_uses_reg  boolean;
BEGIN
  -- Only the roles that can act on it may ask. A viewer seeing a notice with an
  -- Edit button they cannot use is worse than not seeing it.
  IF NOT public.can_admin_org(p_org_id) THEN
    RETURN jsonb_build_object('needs_notice', false);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.org_policy_acknowledgements
    WHERE organization_id = p_org_id AND ack_key = 'starter_cancellation_policy'
  ) INTO v_acked;
  IF v_acked THEN
    RETURN jsonb_build_object('needs_notice', false);
  END IF;

  SELECT * INTO v_row
  FROM public.org_policies
  WHERE organization_id = p_org_id
    AND policy_type = 'cancellation'
    AND published = true
    AND seeded_by_platform = true;

  -- Nothing published under their name that we wrote => nothing to disclose.
  -- This is also the path an operator who has already rewritten their policy
  -- takes: saving their own wording clears seeded_by_platform, and telling
  -- someone we published a policy for them while they are looking at their own
  -- words would simply be false.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('needs_notice', false);
  END IF;

  SELECT slug, coalesce(uses_enrops_registration, true)
    INTO v_slug, v_uses_reg
  FROM public.organizations WHERE id = p_org_id;

  -- Stated as a plain count of the waivers on their Waivers and policies page,
  -- which is true no matter who wrote them and no matter whether this tenant
  -- runs an Enrops registration form. The SENTENCE around it is what varies.
  SELECT count(*) INTO v_waivers
  FROM public.waivers
  WHERE organization_id = p_org_id AND active = true;

  RETURN jsonb_build_object(
    'needs_notice',            true,
    'content_markdown',        v_row.content_markdown,
    'public_path',             '/' || coalesce(v_slug, '') || '/cancellation',
    'effective_date',          v_row.effective_date,
    'active_waiver_count',     v_waivers,
    'uses_enrops_registration', v_uses_reg
  );
END;
$$;

REVOKE ALL ON FUNCTION public.starter_policy_notice(uuid) FROM public;
-- Supabase's project-level default privileges re-grant EXECUTE to anon on every
-- CREATE OR REPLACE, so the revoke has to be repeated here - omitting it would
-- silently reopen the function to anonymous callers that 20260728p closed.
REVOKE ALL ON FUNCTION public.starter_policy_notice(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.starter_policy_notice(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.starter_policy_notice(uuid) TO service_role;

COMMENT ON FUNCTION public.starter_policy_notice(uuid) IS
  'Single source of truth for whether the operator is owed the "a policy is live under your name" notice, the exact text to show, and whether they run Enrops registration (which decides what the notice may truthfully claim about where families see it). Owner/admin only.';
