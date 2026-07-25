-- 20260725d — the three onboarding answers, plus a timezone that isn't a guess.
--
-- A new operator answers three questions when they build their first program.
-- Each answer has to CHANGE something they can see, or it is just a survey:
--
--   venue_answer     -> the builder's Location step. Their own space asks once
--                       and remembers it; going out to sites opens the picker
--                       and expects several.
--   program_cadence  -> the builder's schedule fields. A weekly term asks for a
--                       day + how many classes; a one-off workshop asks for a
--                       single date and nothing else.
--   default_age_*    -> pre-fills every new program's age range, shows "Ages 6-12"
--                       on the family-facing card, and fills the age blank in the
--                       waiver, which today reads "[your minimum age]" verbatim.
--
-- venue_answer is deliberately NOT a third value on venue_model. venue_model
-- picks which admin surface an org gets (Partners vs Locations) and only has
-- meaning for tenants running J2S-shaped partner workflows; these operators are
-- all 'own_venue' there regardless. This column records what the operator
-- actually told us about their own setup.
--
-- All columns are nullable with no default and no backfill: an existing org
-- reads exactly as it did before, and every consumer treats NULL as "not asked".

alter table public.organizations
  add column if not exists venue_answer text,
  add column if not exists program_cadence text,
  add column if not exists default_age_min integer,
  add column if not exists default_age_max integer,
  add column if not exists onboarding_completed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_venue_answer_check') then
    alter table public.organizations
      add constraint organizations_venue_answer_check
      check (venue_answer is null or venue_answer in ('own_space', 'goes_to_sites', 'both'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'organizations_program_cadence_check') then
    alter table public.organizations
      add constraint organizations_program_cadence_check
      check (program_cadence is null or program_cadence in ('weekly_term', 'one_off', 'both'));
  end if;

  -- Ages are a human range, not arbitrary integers. Bounds keep a typo (600)
  -- out of the family-facing card and the waiver.
  if not exists (select 1 from pg_constraint where conname = 'organizations_default_age_range_check') then
    alter table public.organizations
      add constraint organizations_default_age_range_check
      check (
        (default_age_min is null or default_age_min between 0 and 99)
        and (default_age_max is null or default_age_max between 0 and 99)
        and (default_age_min is null or default_age_max is null or default_age_min <= default_age_max)
      );
  end if;
end $$;

comment on column public.organizations.venue_answer is
  'Onboarding: own_space | goes_to_sites | both. Drives the builder location step. Distinct from venue_model, which picks the admin surface shape.';
comment on column public.organizations.program_cadence is
  'Onboarding: weekly_term | one_off | both. Drives which schedule fields the program builder shows.';
comment on column public.organizations.default_age_min is
  'Onboarding: youngest age served. Pre-fills new programs, the public card, and the waiver age clause.';
comment on column public.organizations.default_age_max is
  'Onboarding: oldest age served.';
comment on column public.organizations.onboarding_completed_at is
  'Set when the operator answers the onboarding questions. NULL = never asked, so the card shows once and then stops.';

-- Timezone at provision time.
--
-- organizations.timezone is NOT NULL DEFAULT 'America/Los_Angeles', so every
-- operator outside the Pacific has silently been running on Pacific times since
-- the day they signed up - class times, reminders, everything derived from them.
-- The browser already knows the right answer, so we take it at signup rather
-- than asking a question nobody wants to answer.
--
-- The new argument is added WITH A DEFAULT and the old 1-argument version is
-- dropped in the same statement, so there is never a moment where both exist and
-- a call could be ambiguous. A frontend that still calls this with only the
-- business name keeps working and simply gets the previous behaviour - which is
-- what makes it safe to apply this migration BEFORE the frontend ships.
drop function if exists public.provision_operator_org(text);

create or replace function public.provision_operator_org(
  p_business_name text,
  p_timezone text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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

  -- Only accept a timezone Postgres itself recognises. The value arrives from
  -- the browser, and an unknown name would break every date rendered from it,
  -- so an unrecognised one falls back to the column default rather than failing
  -- the signup - a wrong timezone is fixable in Settings, a failed signup is a
  -- lost operator.
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

  INSERT INTO public.organizations (name, slug, email, platform_plan, platform_fee_card_pct, platform_fee_ach_pct, platform_fee_cap_cents, platform_fee_floor_cents, fee_pass_through, uses_enrops_registration, venue_model, timezone)
    VALUES (v_name, v_slug, v_email, 'free', 0.03, 0.01, 799, 199, true, true, 'own_venue', coalesce(v_tz, 'America/Los_Angeles')) RETURNING id INTO v_org;
  INSERT INTO public.org_members (organization_id, auth_user_id, email, role, accepted_at) VALUES (v_org, v_uid, v_email, 'owner', now());
  PERFORM public.seed_default_waivers(v_org);
  INSERT INTO public.custom_reg_fields (organization_id, field_key, label, field_type, standard_key, is_required, is_active, sort_order)
    VALUES (v_org, 'std_guardian_secondary', 'Second parent or guardian', 'standard', 'guardian_secondary', false, true, 0);
  RETURN jsonb_build_object('slug', v_slug, 'organization_id', v_org, 'already_existed', false);
END; $function$;

-- SECURITY DEFINER: keep it callable by a signed-in visitor with no org yet, and
-- never by an anonymous one. Mirrors the grants the dropped version carried.
-- (verified against the dropped function's ACL: authenticated + service_role, no anon)
--
-- The revoke from anon is NOT redundant. Supabase ships an ALTER DEFAULT
-- PRIVILEGES that grants EXECUTE on new functions to anon, so re-creating this
-- one silently hands it to signed-out visitors - a privilege the dropped version
-- did not have. The body raises 'not authenticated' without a JWT so nothing was
-- exploitable, but a SECURITY DEFINER function should not be callable by anon at
-- all. Checked with pg_proc.proacl after applying, not assumed.
revoke all on function public.provision_operator_org(text, text) from public;
revoke all on function public.provision_operator_org(text, text) from anon;
grant execute on function public.provision_operator_org(text, text) to authenticated;
grant execute on function public.provision_operator_org(text, text) to service_role;
