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

-- p_org_id is an ARGUMENT, authorized with can_admin_org, rather than inferred
-- from the caller's memberships.
--
-- The first version picked `order by created_at limit 1` across the caller's
-- owner/admin rows. That silently renames the WRONG organisation for anyone who
-- administers two: the oldest membership wins regardless of which org's Settings
-- page they are standing on. On prod the oldest row is the J2S ownership, so the
-- day that account is added as an admin to a tenant org for support, renaming
-- from THAT tenant's Settings would rename j2s and break every live J2S link.
-- Nobody holds two memberships today (verified in both environments), which is
-- the only reason this was latent rather than live.
--
-- Taking the org id and authorizing it is the same shape seed_default_waivers
-- uses, and it makes the function say what it does.
create or replace function public.rename_org_slug(p_org_id uuid, p_slug text)
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

  -- Authorize the org the caller actually named. can_admin_org already requires
  -- an accepted owner/admin membership for THIS user on THIS org, so it is both
  -- the authorization and the "which org" answer.
  if p_org_id is null or not public.can_admin_org(p_org_id) then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  v_org := p_org_id;
  select o.slug into v_current from public.organizations o where o.id = v_org;

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
--
-- These four lines named the OLD 1-arg signature (text) while the function above
-- is (uuid, text). On staging that silently worked because the 1-arg function
-- still existed to be revoked, and the correct grants on the 2-arg version were
-- applied out-of-band afterwards - so the live state was right and the file was
-- wrong. On prod, where rename_org_slug does not exist in ANY signature, REVOKE
-- on a missing function is a hard ERROR and the whole migration aborts; and had
-- it not, the new SECURITY DEFINER function - one that WRITES organizations.slug
-- - would have kept Supabase's default anon EXECUTE. Corrected to the real
-- signature so the file reproduces staging's proven state on a clean database.
revoke all on function public.rename_org_slug(uuid, text) from public;
revoke all on function public.rename_org_slug(uuid, text) from anon;
grant execute on function public.rename_org_slug(uuid, text) to authenticated;
grant execute on function public.rename_org_slug(uuid, text) to service_role;
