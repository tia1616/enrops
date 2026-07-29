-- Tell the operator that a cancellation & refund policy is published PUBLICLY
-- under their business name.
--
-- THE PROBLEM THIS CLOSES. Migrations j/k/o gave every tenant - new and
-- pre-existing - a `cancellation` policy with published = true. It renders at
-- /{slug}/cancellation, links from the public footer, and is shown to families
-- on the pay step before they pay. The text is OURS with their business name
-- substituted in, and it makes specific promises about money: full refund before
-- the first session, prorated once started, none after it ends. Nothing anywhere
-- told the operator. Publishing a refund promise on a business's behalf without
-- telling them is a consent problem, not a UX nicety.
--
-- THE TRADE STAYS. We do NOT unpublish. v4 section 6 requires the family to see
-- a policy BEFORE paying, and an unpublished policy shows nothing. The trade is
-- only defensible if the operator is told, so this migration builds the telling.
--
-- WHAT IT ADDS
--   1. org_policies.seeded_by_platform - marks text WE wrote, so we can tell the
--      difference between "our words under their name" and their own policy.
--   2. org_policy_acknowledgements    - the durable record that they were shown
--      it and responded. A consent artifact belongs in the database, not in
--      localStorage, which evaporates on a new device and would leave us unable
--      to say whether anyone was ever told.
--   3. starter_policy_notice()        - the ONE place that decides whether the
--      notice is owed and what it should say.
--   4. acknowledge_starter_policy()   - records the response.

-- ---------------------------------------------------------------------------
-- 1. Mark platform-authored policy text.
-- ---------------------------------------------------------------------------
-- WHY A STORED FLAG RATHER THAN COMPARING TO THE TEMPLATE AT READ TIME. The
-- obvious implementation is "show the notice while the text still equals the
-- enrops template". That silently breaks the first time anyone edits the
-- template: every already-seeded copy stops matching, and the notice quietly
-- stops appearing for operators who were never told. The failure mode is
-- invisible and points the wrong way, so the fact is recorded once, at the
-- moment we author the text, instead of being re-derived later.
ALTER TABLE public.org_policies
  ADD COLUMN IF NOT EXISTS seeded_by_platform boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.org_policies.seeded_by_platform IS
  'True when enrops authored this text and published it under the tenant name, rather than the operator writing it. Drives the first-run consent notice; cleared the moment the operator saves their own wording.';

-- Backfill the rows j/o already created. Matched on SHAPE, not on an exact
-- string: the seeded copy has the business name baked in, so an org renamed
-- between the backfill and this migration would fail an equality test and
-- silently never be told. LIKE against the template with {{org}} widened to %
-- tolerates that. % and _ are escaped first so a template that later grows one
-- cannot turn into an accidental wildcard.
DO $mig$
DECLARE
  v_platform  uuid;
  v_tpl       text;
  v_pattern   text;
  v_marked    int;
  v_candidates int;
BEGIN
  SELECT id INTO v_platform FROM public.organizations WHERE slug = 'enrops';
  IF v_platform IS NULL THEN
    RAISE EXCEPTION 'no enrops platform org - the template lives there, refusing to guess';
  END IF;

  SELECT content_markdown INTO v_tpl
  FROM public.org_policies
  WHERE organization_id = v_platform AND policy_type = 'cancellation';

  IF v_tpl IS NULL THEN
    RAISE EXCEPTION 'the enrops cancellation template is missing - run 20260728j first';
  END IF;

  v_pattern := replace(v_tpl, '\', '\\');
  v_pattern := replace(v_pattern, '%', '\%');
  v_pattern := replace(v_pattern, '_', '\_');
  v_pattern := replace(v_pattern, '{{org}}', '%');

  SELECT count(*) INTO v_candidates
  FROM public.org_policies
  WHERE policy_type = 'cancellation' AND organization_id <> v_platform;

  UPDATE public.org_policies p
     SET seeded_by_platform = true
   WHERE p.policy_type = 'cancellation'
     AND p.organization_id <> v_platform
     AND p.seeded_by_platform = false
     AND p.content_markdown LIKE v_pattern ESCAPE '\';

  GET DIAGNOSTICS v_marked = ROW_COUNT;

  -- Reported, not asserted. A tenant who has already rewritten their policy
  -- SHOULD be left unmarked, so a mismatch is not automatically a fault - but
  -- an unmarked row is an operator who never gets told, so the numbers get
  -- printed and checked by hand rather than assumed.
  RAISE NOTICE 'seeded_by_platform: marked % of % non-platform cancellation policies', v_marked, v_candidates;
END $mig$;

-- ---------------------------------------------------------------------------
-- 2. Keep the flag true for tenants provisioned from here on.
-- ---------------------------------------------------------------------------
-- Same body as 20260728j, plus seeded_by_platform. Redefining is safe: this
-- function is small, owned entirely by this feature, and has exactly one caller
-- (provision_operator_org). Contrast 20260728k, which had to patch a shared
-- function in place precisely because it did NOT own it.
CREATE OR REPLACE FUNCTION public.seed_default_cancellation_policy(p_org_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_platform uuid;
  v_name text;
  v_count int := 0;
BEGIN
  IF NOT public.can_admin_org(p_org_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  SELECT name INTO v_name FROM organizations WHERE id = p_org_id;
  SELECT id INTO v_platform FROM organizations WHERE slug = 'enrops';
  IF v_platform IS NULL THEN RETURN 0; END IF;

  INSERT INTO public.org_policies (organization_id, policy_type, content_markdown, published, effective_date, last_updated, seeded_by_platform)
  SELECT p_org_id, 'cancellation',
         replace(p.content_markdown, '{{org}}', coalesce(nullif(btrim(v_name), ''), 'our program')),
         true, current_date, now(),
         -- Our words under their name. The consent notice keys on this.
         true
  FROM public.org_policies p
  WHERE p.organization_id = v_platform AND p.policy_type = 'cancellation'
  -- Never overwrite a policy the operator has already written.
  ON CONFLICT (organization_id, policy_type) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_default_cancellation_policy(uuid) FROM public;
REVOKE ALL ON FUNCTION public.seed_default_cancellation_policy(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.seed_default_cancellation_policy(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.seed_default_cancellation_policy(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. The consent record.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.org_policy_acknowledgements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Keyed so the same table can carry the next one of these without a migration.
  ack_key          text NOT NULL CHECK (ack_key = ANY (ARRAY['starter_cancellation_policy'])),
  -- Which button. 'accepted' = they read it and kept it. 'editing' = they went
  -- to change it. BOTH are acknowledgements - the duty is discharged by being
  -- shown the wording, not by agreeing with it - but which one they chose is
  -- worth knowing and costs one column.
  response         text NOT NULL CHECK (response = ANY (ARRAY['accepted','editing'])),
  acknowledged_by  uuid DEFAULT auth.uid(),
  acknowledged_at  timestamptz NOT NULL DEFAULT now(),
  -- Per ORG, not per user: the business has been told once an owner or admin
  -- has seen it. A second admin does not need to re-consent on the org's behalf.
  UNIQUE (organization_id, ack_key)
);

COMMENT ON TABLE public.org_policy_acknowledgements IS
  'Durable record that an operator was shown the policy text enrops published under their business name, and how they responded. Consent artifact - do not clear.';

ALTER TABLE public.org_policy_acknowledgements ENABLE ROW LEVEL SECURITY;

-- Read: any member of the org (so a staff-facing surface could report on it).
DROP POLICY IF EXISTS opa_member_read ON public.org_policy_acknowledgements;
CREATE POLICY opa_member_read ON public.org_policy_acknowledgements
  FOR SELECT TO authenticated
  USING (public.is_org_member(organization_id) OR public.is_platform_admin());

-- Write: owner/admin only - the roles that can actually edit the policy.
-- INSERT is the only write verb granted, and that is deliberate. The RPC below
-- writes with ON CONFLICT DO NOTHING, which needs INSERT and nothing more; an
-- UPDATE policy added "for symmetry" would let a first acknowledgement be
-- rewritten later, which is exactly what a consent record must not allow.
DROP POLICY IF EXISTS opa_admin_insert ON public.org_policy_acknowledgements;
CREATE POLICY opa_admin_insert ON public.org_policy_acknowledgements
  FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_org(organization_id) OR public.is_platform_admin());

-- A new public table is invisible to PostgREST without table-level grants, RLS
-- notwithstanding. See feedback_security_definer_grants.
GRANT SELECT, INSERT ON public.org_policy_acknowledgements TO authenticated;
GRANT SELECT, INSERT ON public.org_policy_acknowledgements TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Is the notice owed, and what should it say?
-- ---------------------------------------------------------------------------
-- ONE place computes this. The alternative - the browser fetching the policy,
-- the template and the ack row and deciding for itself - re-derives the rule in
-- a second language, which is how a screen ends up disagreeing with the database
-- about what an operator has been told.
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

  SELECT slug INTO v_slug FROM public.organizations WHERE id = p_org_id;

  -- Stated as a plain count of what families sign, which is true no matter who
  -- wrote them. Claiming "we added 4 waivers for you" would be false for any
  -- tenant who wrote their own.
  SELECT count(*) INTO v_waivers
  FROM public.waivers
  WHERE organization_id = p_org_id AND active = true;

  RETURN jsonb_build_object(
    'needs_notice',      true,
    'content_markdown',  v_row.content_markdown,
    'public_path',       '/' || coalesce(v_slug, '') || '/cancellation',
    'effective_date',    v_row.effective_date,
    'active_waiver_count', v_waivers
  );
END;
$$;

REVOKE ALL ON FUNCTION public.starter_policy_notice(uuid) FROM public;
-- Supabase's project-level default privileges GRANT EXECUTE on every new
-- function to anon and authenticated. Omitting a GRANT does not withhold it -
-- it has to be revoked. `authenticated` is then granted back deliberately,
-- because the admin shell calls this from the browser; anon never should.
REVOKE ALL ON FUNCTION public.starter_policy_notice(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.starter_policy_notice(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.starter_policy_notice(uuid) TO service_role;

COMMENT ON FUNCTION public.starter_policy_notice(uuid) IS
  'Single source of truth for whether the operator is owed the "a policy is live under your name" notice, and the exact text to show. Owner/admin only.';

-- ---------------------------------------------------------------------------
-- 5. Record the response.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.acknowledge_starter_policy(p_org_id uuid, p_response text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_admin_org(p_org_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_response IS NULL OR p_response NOT IN ('accepted','editing') THEN
    RAISE EXCEPTION 'unknown response %', p_response;
  END IF;

  -- DO NOTHING, not DO UPDATE: the first acknowledgement is the one that
  -- happened. Two admins clicking at once must not produce a duplicate-key
  -- error in either browser, and a later click must not overwrite the earlier
  -- record of who was told and when.
  INSERT INTO public.org_policy_acknowledgements (organization_id, ack_key, response, acknowledged_by)
  VALUES (p_org_id, 'starter_cancellation_policy', p_response, auth.uid())
  ON CONFLICT (organization_id, ack_key) DO NOTHING;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_starter_policy(uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.acknowledge_starter_policy(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_starter_policy(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acknowledge_starter_policy(uuid, text) TO service_role;

COMMENT ON FUNCTION public.acknowledge_starter_policy(uuid, text) IS
  'Records that an owner/admin was shown the platform-authored cancellation policy published under their business name. First write wins; never overwritten.';
