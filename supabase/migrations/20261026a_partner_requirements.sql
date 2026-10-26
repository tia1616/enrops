-- What each partner requires (Jessica, 2026-10-26).
--
-- WHY. Every partner saw every item, so Happy Valley, which does not ask for a
-- business license, was shown a red "Expired or Missing" for one. Her words:
-- "if documents aren't required ... isn't it alarming and inefficient to show
-- that that's missing, if they don't need it?" Compliance tools (TrustLayer,
-- myCOI, Ankored) measure a provider only against what that host requires.
-- So each partner now has a list, and the portal shows and counts only what is
-- on it. Something not required but on file is listed quietly; something not
-- required and not on file is not shown at all.
--
-- WHO SETS IT. Today the provider's owner or admin, on Partner portal, from the
-- partner's own packet. Spec v3 H3 (Nov 6) lets the host edit its own list;
-- that reuses this table and these functions rather than adding a second list.
--
-- DEFAULTS LIVE IN ONE PLACE: partner_requirements_for(). A partner with no
-- rows gets the standard packet (everything except a business license, which
-- only some hosts ask for; West Linn does). Rows store only what someone set.
--
-- NO DIRECT TABLE ACCESS for clients: reads and writes go through the two
-- SECURITY DEFINER functions, which carry the access rules. Grants are
-- explicit because from 2026-10-30 Supabase no longer grants new public tables
-- to anyone automatically.

create table if not exists public.partner_requirements (
  partner_id       uuid not null references public.partners(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  requirement_key  text not null,
  required         boolean not null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  primary key (partner_id, requirement_key),
  constraint partner_requirements_key_check check (requirement_key in (
    'insurance', 'partner_agreement', 'business_license',
    'background_check', 'training', 'code_of_conduct', 'mandatory_reporter', 'contractor_agreement'
  ))
);

alter table public.partner_requirements enable row level security;
revoke all on public.partner_requirements from public, anon, authenticated;
grant all on public.partner_requirements to service_role;

comment on table public.partner_requirements is
  'Per-partner overrides of the standard requirement list. Read through partner_requirements_for(), written through set_partner_requirement(); defaults live in partner_requirements_for().';

-- Every key with its required flag, defaults applied. Readable by the
-- provider's members (the admin screen) and by that partner's own logins (the
-- portal). Anyone else gets no rows.
create or replace function public.partner_requirements_for(p_partner_id uuid)
returns table (requirement_key text, required boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select p.organization_id into v_org from public.partners p where p.id = p_partner_id;
  if v_org is null then
    return;
  end if;
  if not (
    public.is_org_member(v_org)
    or exists (select 1 from private.current_partner_access() a where a.partner_id = p_partner_id)
  ) then
    return;
  end if;

  return query
  with defaults(requirement_key, required, sort) as (
    values
      ('insurance', true, 1),
      ('partner_agreement', true, 2),
      ('business_license', false, 3),
      ('background_check', true, 4),
      ('training', true, 5),
      ('code_of_conduct', true, 6),
      ('mandatory_reporter', true, 7),
      ('contractor_agreement', true, 8)
  )
  select d.requirement_key, coalesce(r.required, d.required)
  from defaults d
  left join public.partner_requirements r
    on r.partner_id = p_partner_id and r.requirement_key = d.requirement_key
  order by d.sort;
end;
$$;

-- Set one requirement for one partner. The provider's owner or admin only.
-- Appends to audit_events so a host can later see when its list changed.
create or replace function public.set_partner_requirement(p_partner_id uuid, p_requirement_key text, p_required boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_before boolean;
begin
  select p.organization_id into v_org from public.partners p where p.id = p_partner_id;
  if v_org is null or not public.can_admin_org(v_org) then
    return false;
  end if;
  if p_required is null then
    raise exception 'required must be true or false' using errcode = 'PR001';
  end if;

  select f.required into v_before
  from public.partner_requirements_for(p_partner_id) f
  where f.requirement_key = p_requirement_key;
  if not found then
    raise exception 'Unknown requirement' using errcode = 'PR002';
  end if;

  insert into public.partner_requirements (partner_id, organization_id, requirement_key, required, updated_at, updated_by)
  values (p_partner_id, v_org, p_requirement_key, p_required, now(), auth.uid())
  on conflict (partner_id, requirement_key)
  do update set required = excluded.required, updated_at = now(), updated_by = auth.uid();

  if v_before is distinct from p_required then
    insert into public.audit_events (organization_id, partner_id, actor_user_id, actor_role, action, subject_type, before, after)
    values (v_org, p_partner_id, auth.uid(), 'provider_admin', 'partner_requirement_changed', 'partner_requirement',
            jsonb_build_object('key', p_requirement_key, 'required', v_before),
            jsonb_build_object('key', p_requirement_key, 'required', p_required));
  end if;
  return true;
end;
$$;

revoke all on function public.partner_requirements_for(uuid) from public, anon;
grant execute on function public.partner_requirements_for(uuid) to authenticated, service_role;
revoke all on function public.set_partner_requirement(uuid, text, boolean) from public, anon;
grant execute on function public.set_partner_requirement(uuid, text, boolean) to authenticated, service_role;
