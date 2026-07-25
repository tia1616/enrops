-- 20260725g — let an operator actually change their page address.
--
-- Signup tells every new operator, twice, "you can change this address anytime
-- in Settings". Nothing in Settings could change it. The slug was set once at
-- provisioning and there was no surface, no RPC, and no code path to alter it.
--
-- Why this needs a function rather than a plain UPDATE from the client:
--
--   1. Uniqueness cannot be checked from the browser. RLS (members_read_own_org)
--      only lets an operator see their OWN organisation, so a client-side "is
--      this taken?" query always comes back empty even when the slug belongs to
--      someone else. The UPDATE would then fail on the unique index and surface
--      a raw duplicate-key error to a non-technical operator.
--   2. The reserved-word list has to match provisioning exactly, or an operator
--      could rename themselves onto /admin or /login and break their own site.
--      One list, one place.
--
-- Returns a plain-language code the UI maps to a sentence, rather than raising,
-- so an expected outcome (taken, reserved, malformed) isn't an error state.
--
-- Owner/admin only, via can_admin_org, and it can only ever touch the caller's
-- own organisation - the org id is looked up from the caller, never accepted as
-- an argument.

create or replace function public.rename_org_slug(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_current text;
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_reserved text[] := ARRAY['admin','login','signup','sign-up','api','app','www','enrops','register','registration','dashboard','settings','instructor','portal','j2s','account','auth','static','assets','public','help','support','about','pricing'];
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'not_authenticated');
  end if;

  select m.organization_id, o.slug into v_org, v_current
  from public.org_members m
  join public.organizations o on o.id = m.organization_id
  where m.auth_user_id = v_uid and m.role in ('owner', 'admin')
  order by m.created_at
  limit 1;

  if v_org is null or not public.can_admin_org(v_org) then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;

  -- Same shape provisioning generates: lowercase letters, numbers, hyphens.
  if v_slug !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' then
    return jsonb_build_object('ok', false, 'code', 'invalid');
  end if;
  if length(v_slug) < 3 or length(v_slug) > 40 then
    return jsonb_build_object('ok', false, 'code', 'length');
  end if;
  if v_slug = any(v_reserved) then
    return jsonb_build_object('ok', false, 'code', 'reserved');
  end if;

  if v_slug = v_current then
    return jsonb_build_object('ok', true, 'slug', v_slug, 'unchanged', true);
  end if;

  if exists (select 1 from public.organizations where slug = v_slug and id <> v_org) then
    return jsonb_build_object('ok', false, 'code', 'taken');
  end if;

  update public.organizations set slug = v_slug where id = v_org;

  return jsonb_build_object('ok', true, 'slug', v_slug, 'previous', v_current, 'unchanged', false);
exception
  -- Someone else claimed the slug between the check and the write.
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'taken');
end;
$function$;

-- SECURITY DEFINER: signed-in admins only. The revoke from anon is not
-- redundant - Supabase's default privileges grant EXECUTE on new functions to
-- anon, and this one writes.
revoke all on function public.rename_org_slug(text) from public;
revoke all on function public.rename_org_slug(text) from anon;
grant execute on function public.rename_org_slug(text) to authenticated;
grant execute on function public.rename_org_slug(text) to service_role;
