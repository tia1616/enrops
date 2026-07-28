-- Seed a default cancellation policy for a new tenant, mirroring exactly how
-- default WAIVERS already work: the platform template lives as a row under the
-- `enrops` org with the operator name tokenised as {{org}}, and a SECURITY
-- DEFINER function copies it into the tenant at provisioning, substituting the
-- real name. Same shape as seed_default_waivers(), same admin gate.
--
-- WHY IT IS SEEDED PUBLISHED. v4 section 6 requires the family to see a
-- cancellation policy BEFORE paying. A tenant who never writes one would show
-- nothing at checkout and quietly fail that requirement. Seeding it published
-- means the requirement holds from day one. The trade is real and worth stating:
-- a new operator goes live with OUR wording until they edit it, so the default
-- is deliberately conservative and mirrors what the platform itself does with
-- its fee (full before the first session, prorated during, none after the end).

-- 1. The platform template. Idempotent on the (org, type) unique index.
INSERT INTO public.org_policies (organization_id, policy_type, content_markdown, published, effective_date, last_updated)
SELECT o.id, 'cancellation',
'## Cancelling a registration

If you need to cancel, contact {{org}} as early as you can. The sooner we know, the more likely we can offer the spot to another family.

**Before the first session.** Full refund.

**Once the program has started.** We refund the sessions your child has not yet attended.

**After the program has finished.** No refund.

If {{org}} cancels a class, you receive a full refund regardless of timing.

Questions about a refund? Reply to your confirmation email and it comes straight to us.',
  true, current_date, now()
FROM public.organizations o
WHERE o.slug = 'enrops'
ON CONFLICT (organization_id, policy_type) DO NOTHING;

-- 2. The copier. Deliberately the same signature, gate and return shape as
--    seed_default_waivers so the two read as siblings.
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

  INSERT INTO public.org_policies (organization_id, policy_type, content_markdown, published, effective_date, last_updated)
  SELECT p_org_id, 'cancellation',
         replace(p.content_markdown, '{{org}}', coalesce(nullif(btrim(v_name), ''), 'our program')),
         true, current_date, now()
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
GRANT EXECUTE ON FUNCTION public.seed_default_cancellation_policy(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.seed_default_cancellation_policy(uuid) TO service_role;

COMMENT ON FUNCTION public.seed_default_cancellation_policy(uuid) IS
  'Copies the enrops-org cancellation template into a tenant, substituting {{org}}. Sibling of seed_default_waivers. Never overwrites an existing policy.';
