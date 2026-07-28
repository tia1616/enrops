-- Give EXISTING tenants a cancellation policy, not just newly provisioned ones.
--
-- WHY THIS IS NEEDED AT ALL. Migrations j and k seed the platform template and
-- wire it into provisioning, so every tenant created from now on opens with a
-- cancellation policy. Neither touches an org that already exists. That was easy
-- to miss on staging (where the only orgs with a policy were ones I had seeded
-- by hand) and would have been a real failure on prod: v4 section 6 requires the
-- family to see a cancellation policy BEFORE paying, and every tenant currently
-- taking money - J2S included - would have shown them nothing at the pay step.
-- Jessica, 2026-07-28, asked for the backfill explicitly.
--
-- WHAT IT DOES NOT DO. It never overwrites. Any org that already has a
-- `cancellation` row, published or draft, is left exactly as it is - the unique
-- index on (organization_id, policy_type) makes that structural rather than a
-- promise. The `enrops` org is skipped because its row IS the template.
--
-- PUBLISHED, DELIBERATELY. An unpublished policy shows the family nothing, which
-- is the exact gap this closes. The trade is stated plainly: an existing operator
-- goes live with OUR wording under THEIR name until they edit it, so the default
-- is conservative and mirrors what the platform itself does with its fee. Every
-- operator can rewrite it under Waivers and policies, and their edit wins
-- forever after.
--
-- Idempotent: re-running inserts nothing.

DO $mig$
DECLARE
  v_platform uuid;
  v_inserted int;
BEGIN
  SELECT id INTO v_platform FROM public.organizations WHERE slug = 'enrops';
  IF v_platform IS NULL THEN
    RAISE EXCEPTION 'no enrops platform org - the template lives there, refusing to guess';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.org_policies
    WHERE organization_id = v_platform AND policy_type = 'cancellation'
  ) THEN
    RAISE EXCEPTION 'the enrops cancellation template is missing - run 20260728j first';
  END IF;

  INSERT INTO public.org_policies
    (organization_id, policy_type, content_markdown, published, effective_date, last_updated)
  SELECT
    o.id,
    'cancellation',
    replace(t.content_markdown, '{{org}}', coalesce(nullif(btrim(o.name), ''), 'our program')),
    true,
    current_date,
    now()
  FROM public.organizations o
  CROSS JOIN (
    SELECT content_markdown FROM public.org_policies
    WHERE organization_id = v_platform AND policy_type = 'cancellation'
  ) t
  WHERE o.id <> v_platform
  ON CONFLICT (organization_id, policy_type) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RAISE NOTICE 'backfilled cancellation policy for % tenant(s)', v_inserted;
END $mig$;
