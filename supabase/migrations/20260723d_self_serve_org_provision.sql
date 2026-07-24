-- Self-serve operator org provisioning — Registration MVP, Chunk 1.
-- Spec: memory project_enrops_registration_build (Monday MVP).
--
-- Today only platform admins can create orgs (organizations INSERT policy =
-- is_platform_admin()), and a brand-new user cannot insert their own owner
-- membership (owners_manage_members requires already being an owner). So a cold
-- operator cannot self-provision via client RLS. This adds ONE controlled,
-- atomic SECURITY DEFINER doorway that a freshly-signed-in (magic-link/Google)
-- authenticated user calls to stand up their org.
--
-- Additive + inert to existing tenants:
--   * platform_fee_floor_cents is added NULLable with NO default, so existing
--     orgs (j2s, enrops) are unchanged and the fee computation (paired fee
--     chunk) treats NULL as "no floor". Only NEW self-serve orgs get 199 set.
--   * No existing policy/behavior is altered.
--
-- Applied to staging (mumfymlapolsfdnpewci) first, tested as a real authenticated
-- user, THEN prod (iuasfpztkmrtagivlhtj) in the same release pass (parity).

-- ============================================================================
-- 1. Fee floor column (additive, NULL = no floor; set only for new self-serve orgs)
-- ============================================================================
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS platform_fee_floor_cents integer NULL;

COMMENT ON COLUMN public.organizations.platform_fee_floor_cents IS
  'Minimum enrops platform fee per transaction, in cents. NULL = no floor (legacy/existing orgs unchanged). Self-serve registration orgs are provisioned with 199 ($1.99) per the registration fee model (3% / $1.99 floor / $7.99 ceiling). Read by the fee computation alongside platform_fee_*_pct and platform_fee_cap_cents.';

-- ============================================================================
-- 2. provision_operator_org() — atomic self-serve org creation
-- ============================================================================
-- SECURITY DEFINER: bypasses RLS, so the body is the only gate. It creates an
-- org OWNED BY THE CALLER ONLY (auth.uid()) — it cannot be used to provision for
-- anyone else. One org per account (MVP anti-spam): if the caller already OWNS an
-- org, it returns that org's slug instead of creating a duplicate (idempotent
-- re-entry). Whole body is one implicit transaction — any raise rolls back the
-- partial org/member/seed writes.
CREATE OR REPLACE FUNCTION public.provision_operator_org(p_business_name text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_email  text := nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '');
  v_name   text := btrim(coalesce(p_business_name, ''));
  v_base   text;
  v_slug   text;
  v_n      int := 1;
  v_org    uuid;
  v_existing_slug text;
  v_reserved text[] := ARRAY[
    'admin','login','signup','sign-up','api','app','www','enrops','register',
    'registration','dashboard','settings','instructor','portal','j2s','account',
    'auth','static','assets','public','help','support','about','pricing'
  ];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION 'business name is required';
  END IF;
  -- org_members.email is NOT NULL; fail clearly if the session carries no email
  -- (rather than a cryptic constraint error mid-provision).
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'email unavailable';
  END IF;

  -- One org per account: if the caller already OWNS an org, return it (no dup).
  SELECT o.slug INTO v_existing_slug
  FROM public.org_members m
  JOIN public.organizations o ON o.id = m.organization_id
  WHERE m.auth_user_id = v_uid AND m.role = 'owner'
  ORDER BY m.created_at
  LIMIT 1;
  IF v_existing_slug IS NOT NULL THEN
    RETURN jsonb_build_object('slug', v_existing_slug, 'already_existed', true);
  END IF;

  -- Slug from business name; collision- and reserved-word-safe.
  v_base := lower(regexp_replace(v_name, '[^a-zA-Z0-9]+', '-', 'g'));
  v_base := btrim(v_base, '-');
  IF v_base = '' THEN
    v_base := 'studio';
  END IF;
  v_base := left(v_base, 40);
  v_base := btrim(v_base, '-');
  v_slug := v_base;
  WHILE (v_slug = ANY(v_reserved))
     OR EXISTS (SELECT 1 FROM public.organizations WHERE slug = v_slug) LOOP
    v_n := v_n + 1;
    v_slug := v_base || '-' || v_n;
  END LOOP;

  -- Create the org with the registration fee model + generic-operator defaults.
  INSERT INTO public.organizations (
    name, slug, email, platform_plan,
    platform_fee_card_pct, platform_fee_ach_pct,
    platform_fee_cap_cents, platform_fee_floor_cents,
    fee_pass_through, uses_enrops_registration, venue_model
  ) VALUES (
    v_name, v_slug, v_email, 'free',
    0.03, 0.01,   -- card 3% / ACH 1% (Arielle fee model 2027-07-23), same floor/cap
    799, 199,
    true, true, 'own_venue'
  )
  RETURNING id INTO v_org;

  -- Make the caller the OWNER (accepted immediately — no invite step).
  INSERT INTO public.org_members (organization_id, auth_user_id, email, role, accepted_at)
  VALUES (v_org, v_uid, v_email, 'owner', now());

  -- Seed defaults. Membership row above is visible in-txn, so can_admin_org()
  -- inside seed_default_waivers() passes.
  PERFORM public.seed_default_waivers(v_org);

  -- Lean generic form: second parent/guardian ON by default (Jessica 7/23).
  -- Absent rows = the after-school safety questions stay OFF.
  INSERT INTO public.custom_reg_fields
    (organization_id, field_key, label, field_type, standard_key, is_required, is_active, sort_order)
  VALUES
    (v_org, 'std_guardian_secondary', 'Second parent or guardian',
     'standard', 'guardian_secondary', false, true, 0);

  RETURN jsonb_build_object('slug', v_slug, 'organization_id', v_org, 'already_existed', false);
END;
$function$;

-- Lock the doorway: Supabase auto-grants EXECUTE to anon+authenticated; revoke,
-- then grant only to authenticated (a session is required — auth.uid()).
REVOKE EXECUTE ON FUNCTION public.provision_operator_org(text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.provision_operator_org(text) TO authenticated;
