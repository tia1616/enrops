-- A new business starts on the money-layer fee numbers, by any route.
--
-- WHY. The money-layer doc (2026-09-16, section 4) sets what families pay: 3%
-- card, 2% bank, $1.99 minimum, $14.99 card ceiling, $9.99 bank ceiling, per
-- registration line, family pays by default. Those numbers already live in ONE
-- place, platform_settings.default_fee_config. But a new business never read
-- them:
--   - provision_operator_org (self-serve signup, the only route that creates
--     businesses today) hardcoded 3% / 1% / $7.99 cap / no bank cap - the
--     numbers from before the doc. Write a Thank You Note, Jump Start, Nu Yoga,
--     Pickleball Stars and kimmm were all created on them.
--   - The column defaults, used by any other route, were 1% / 1% / no cap /
--     no minimum / business pays.
-- Jessica 2026-10-12: "yes new bus start on docs numbers". Item "fee defaults on
-- the provider record so a wrongly-priced provider cannot be created by any
-- route" from Arielle's three small fixes.
--
-- WHAT.
--   1. default_fee_value(key): reads one number from default_fee_config.
--   2. The five fee columns DEFAULT to it, so every INSERT that does not name
--      them - from any route - gets the doc's numbers, and changing
--      default_fee_config changes what the NEXT business starts on, with no
--      second copy of the numbers to keep in step. fee_pass_through defaults to
--      true (family pays), per the doc.
--   3. provision_operator_org stops naming the fee columns, so it takes the
--      defaults instead of its own stale copy. Nothing else in it changes.
--
-- WHAT THIS DOES NOT DO. No existing business changes. A DEFAULT applies only to
-- rows inserted after it; no UPDATE runs here. Live businesses were promised
-- notice before any increase, and pricing for them is Arielle's call.
--
-- FAIL CLOSED. If default_fee_config or one of its keys is missing,
-- default_fee_value raises, so the INSERT fails and signup shows an error,
-- rather than quietly creating a business with no fee or a guessed one - which
-- is the exact thing this exists to stop. The row exists on both databases.
--
-- THE MONEY GUARD. This changes column DEFAULTS only. It does not touch
-- guard_organizations_locked_columns, audit_organization_money, or any
-- trigger, so who may change these columns, and what is recorded when they do,
-- is unchanged. Re-read the four guard hashes after applying.
begin;

create or replace function public.default_fee_value(p_key text)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v numeric;
begin
  select (value ->> p_key)::numeric into v
    from public.platform_settings
   where key = 'default_fee_config';
  if v is null then
    raise exception 'platform_settings.default_fee_config has no %', p_key;
  end if;
  return v;
end;
$$;

-- revoke from public does NOT remove anon's EXECUTE on Supabase; name anon.
revoke all on function public.default_fee_value(text) from public, anon;
grant execute on function public.default_fee_value(text) to authenticated, service_role;

alter table public.organizations
  alter column platform_fee_card_pct     set default public.default_fee_value('card_pct'),
  alter column platform_fee_ach_pct      set default public.default_fee_value('ach_pct'),
  alter column platform_fee_floor_cents  set default public.default_fee_value('floor_cents')::integer,
  alter column platform_fee_cap_cents    set default public.default_fee_value('card_cap_cents')::integer,
  alter column platform_fee_ach_cap_cents set default public.default_fee_value('ach_cap_cents')::integer,
  alter column fee_pass_through          set default true;

-- The row's own note said it is read only once an org's override date passes.
-- It is now also what every NEW business starts on, so say so where the next
-- person editing the numbers will read it. Text only; no fee key changes.
update public.platform_settings
   set value = jsonb_set(value, '{note}', to_jsonb(
     'Money layer 2026-09-16 section 4. Applied PER REGISTRATION LINE, never per cart. '
     || 'Read (1) when an organisation platform_fee_override_until has passed, and '
     || '(2) as the starting fees of EVERY NEW business, through the organizations column '
     || 'defaults (20261012c). Changing a number here changes what the next business starts on; '
     || 'it never changes an existing business''s own columns.'::text))
 where key = 'default_fee_config';

create or replace function public.provision_operator_org(p_business_name text, p_timezone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_email text := nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '');
  v_name text := btrim(coalesce(p_business_name, ''));
  v_tz text := nullif(btrim(coalesce(p_timezone, '')), '');
  v_base text; v_slug text; v_n int := 1; v_org uuid; v_existing_slug text;
  v_reserved text[] := ARRAY['admin','login','signup','sign-up','api','app','www','enrops','register','registration','dashboard','settings','instructor','portal','j2s','account','auth','static','assets','public','help','support','about','pricing'];
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF v_name = '' THEN RAISE EXCEPTION 'business name is required'; END IF;
  IF v_email IS NULL THEN RAISE EXCEPTION 'email unavailable'; END IF;

  IF v_tz IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_tz) THEN
    v_tz := NULL;
  END IF;

  SELECT o.slug INTO v_existing_slug FROM public.org_members m JOIN public.organizations o ON o.id = m.organization_id
    WHERE m.auth_user_id = v_uid AND m.role = 'owner' ORDER BY m.created_at LIMIT 1;
  IF v_existing_slug IS NOT NULL THEN RETURN jsonb_build_object('slug', v_existing_slug, 'already_existed', true); END IF;

  v_base := lower(regexp_replace(v_name, '[^a-zA-Z0-9]+', '-', 'g')); v_base := btrim(v_base, '-');
  IF v_base = '' THEN v_base := 'studio'; END IF; v_base := left(v_base, 40); v_base := btrim(v_base, '-'); v_slug := v_base;
  WHILE (v_slug = ANY(v_reserved)) OR EXISTS (SELECT 1 FROM public.organizations WHERE slug = v_slug) LOOP
    v_n := v_n + 1; v_slug := v_base || '-' || v_n; END LOOP;

  -- Fee columns deliberately NOT named: they take their DEFAULTs, which read
  -- platform_settings.default_fee_config (20261012c). This used to hardcode
  -- 0.03 / 0.01 / 799 / 199 / true, a stale copy of the pricing.
  INSERT INTO public.organizations (name, slug, email, platform_plan, uses_enrops_registration, venue_model, timezone)
    VALUES (v_name, v_slug, v_email, 'free', true, 'own_venue', coalesce(v_tz, 'America/Los_Angeles')) RETURNING id INTO v_org;
  INSERT INTO public.org_members (organization_id, auth_user_id, email, role, accepted_at) VALUES (v_org, v_uid, v_email, 'owner', now());
  PERFORM public.seed_default_waivers(v_org);
  -- v4 section 6: a tenant must have a cancellation policy to show at
  -- checkout from day one. Same platform-template pattern as the waivers
  -- above; never overwrites one the operator has already written.
  PERFORM public.seed_default_cancellation_policy(v_org);
  INSERT INTO public.custom_reg_fields (organization_id, field_key, label, field_type, standard_key, is_required, is_active, sort_order)
    VALUES (v_org, 'std_guardian_secondary', 'Second parent or guardian', 'standard', 'guardian_secondary', false, true, 0);
  RETURN jsonb_build_object('slug', v_slug, 'organization_id', v_org, 'already_existed', false);
END; $function$;

commit;
