-- Partner logins limited to some of a partner's sites (Jessica 2026-10-30,
-- following Arielle's Oct 28 Impact NW one-pager: "Each person sees only their
-- own sites"). A large host (Impact NW runs SUN at many schools; a parks
-- district has many facilities) gives its lead every site and each site
-- manager only theirs.
--
-- partner_portal_access.site_ids: NULL = every site of the partner (every login
-- before this migration keeps exactly what it sees today). Otherwise the
-- program_locations under that partner this login may see.
--
-- What it limits: the instructors list (partner_portal_instructors), which is
-- the only per-site thing a partner reads. Documents and requirements are the
-- partner organization's own and stay visible to all of its logins.
--
-- One rule, one place: private.partner_sites_checked() validates and
-- normalises a site list for BOTH writers (the insert guard and
-- set_partner_access_sites). There is still no UPDATE grant on the table, so
-- the RPC is the only way to change a login's sites.

begin;

alter table public.partner_portal_access
  add column if not exists site_ids uuid[];

alter table public.partner_portal_access
  drop constraint if exists partner_portal_access_site_ids_not_empty;
alter table public.partner_portal_access
  add constraint partner_portal_access_site_ids_not_empty
  check (site_ids is null or cardinality(site_ids) > 0);

-- NULL in = NULL out (every site). Otherwise: at least one site, every one of
-- them a site of p_partner_id, returned de-duplicated and sorted.
create or replace function private.partner_sites_checked(p_partner_id uuid, p_site_ids uuid[])
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sites uuid[];
begin
  if p_site_ids is null then
    return null;
  end if;
  select array_agg(distinct s order by s) into v_sites
  from unnest(p_site_ids) s
  where s is not null;
  if v_sites is null then
    raise exception 'Choose at least one site, or every site.' using errcode = '23514';
  end if;
  if exists (
    select 1 from unnest(v_sites) s
    where not exists (
      select 1 from public.program_locations pl
      where pl.id = s and pl.partner_id = p_partner_id
    )
  ) then
    raise exception 'That site isn''t one of this partner''s sites.' using errcode = '23514';
  end if;
  return v_sites;
end;
$$;

revoke all on function private.partner_sites_checked(uuid, uuid[]) from public, anon, authenticated;

-- The insert guard: unchanged, plus the site list checked against the partner
-- the guard has just taken from the contact.
create or replace function public.guard_partner_portal_access()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_org uuid;
  v_partner uuid;
  v_email text;
begin
  select c.organization_id, c.partner_id, nullif(btrim(c.contact_email), '')
    into v_org, v_partner, v_email
  from public.partner_contacts c where c.id = new.contact_id;
  if v_org is null or v_partner is null then
    raise exception 'partner_portal_access: contact not found or not linked to a partner'
      using errcode = '23503';
  end if;
  if v_email is null then
    raise exception 'partner_portal_access: that contact has no email address'
      using errcode = '23514';
  end if;
  new.organization_id := v_org;
  new.partner_id := v_partner;
  new.granted_by := auth.uid();
  new.auth_user_id := null;
  new.site_ids := private.partner_sites_checked(v_partner, new.site_ids);
  return new;
end;
$function$;

-- The sites the signed-in person may see for one partner: NULL = every site
-- (any of their logins for that partner is unrestricted), otherwise the union
-- of their logins' sites. No login at all = an empty list, never NULL, so a
-- caller that forgets to check access first still sees nothing.
create or replace function private.partner_access_sites(p_partner_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when bool_or(a.site_ids is null) then null
           else coalesce(array_agg(distinct s) filter (where s is not null), '{}'::uuid[])
         end
  from public.partner_portal_access a
  left join lateral unnest(a.site_ids) s on true
  where auth.uid() is not null
    and a.auth_user_id = auth.uid()
    and a.partner_id = p_partner_id;
$$;

revoke all on function private.partner_access_sites(uuid) from public, anon, authenticated;

-- Change which sites an existing login sees. Owner/admin of the provider only
-- (false = refused, the set_partner_requirement shape). NULL = every site.
create or replace function public.set_partner_access_sites(p_access_id uuid, p_site_ids uuid[])
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_partner uuid;
  v_before uuid[];
  v_after uuid[];
begin
  select a.organization_id, a.partner_id into v_org, v_partner
  from public.partner_portal_access a where a.id = p_access_id;
  if v_org is null or not public.can_admin_org(v_org) then
    return false;
  end if;

  -- Two admins editing the same login queue here, so each audit row's
  -- "before" is what the other one left.
  select a.site_ids into v_before
  from public.partner_portal_access a where a.id = p_access_id
  for update;

  v_after := private.partner_sites_checked(v_partner, p_site_ids);

  update public.partner_portal_access set site_ids = v_after where id = p_access_id;

  if v_before is distinct from v_after then
    insert into public.audit_events (organization_id, partner_id, actor_user_id, actor_role, action, subject_type, subject_id, before, after)
    values (v_org, v_partner, auth.uid(), 'provider_admin', 'partner_access_sites_changed', 'partner_portal_access', p_access_id,
            jsonb_build_object('site_ids', to_jsonb(v_before)),
            jsonb_build_object('site_ids', to_jsonb(v_after)));
  end if;
  return true;
end;
$$;

revoke all on function public.set_partner_access_sites(uuid, uuid[]) from public, anon;
grant execute on function public.set_partner_access_sites(uuid, uuid[]) to authenticated;

-- The instructors list, limited to the caller's sites. Body unchanged except
-- v_sites and the two "pl.id = any(v_sites)" filters. The provider's own
-- owner/admin always sees every site (it is their admin preview).
create or replace function public.partner_portal_instructors(p_partner_id uuid)
 returns table(instructor_id uuid, first_name text, last_name text, sites text[], shared boolean, email text, phone text, background_check_completed_on date, background_check_expires_on date, background_check_status text, background_check_vendor text, background_check_as_of date, training_completed_on date, training_as_of date, code_of_conduct_on date, mandatory_reporter_on date, agreement_signed_on date)
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_org uuid;
  v_today date;
  v_months integer;
  v_sites uuid[];  -- null = every site of the partner
begin
  select p.organization_id into v_org from public.partners p where p.id = p_partner_id;
  if v_org is null then
    return;
  end if;
  if public.can_admin_org(v_org) then
    v_sites := null;
  elsif exists (select 1 from private.current_partner_access() a where a.partner_id = p_partner_id) then
    v_sites := private.partner_access_sites(p_partner_id);
  else
    return;
  end if;
  v_today := (now() at time zone coalesce(
    (select o.timezone from public.organizations o where o.id = v_org), 'America/Los_Angeles'))::date;
  v_months := private.background_check_valid_months(v_org);

  return query
  with assigned as (
    select pa.instructor_id, pl.name as site
    from public.program_assignments pa
    join public.programs pr on pr.id = pa.program_id
    join public.program_locations pl on pl.id = pr.program_location_id
    where pl.partner_id = p_partner_id
      and (v_sites is null or pl.id = any(v_sites))
      and pa.organization_id = v_org
      and pa.status = 'confirmed'
      and coalesce(pr.status, '') <> 'cancelled'
      and coalesce(
            (select max(d) from unnest(public.derive_program_session_dates(pr.id)) d),
            v_today) >= v_today
    union
    select ca.instructor_id, pl.name
    from public.camp_assignments ca
    join public.camp_sessions cs on cs.id = ca.camp_session_id
    join public.program_locations pl on pl.id = cs.location_id
    where pl.partner_id = p_partner_id
      and (v_sites is null or pl.id = any(v_sites))
      and ca.organization_id = v_org
      and ca.status = 'confirmed'
      and coalesce(cs.status, '') <> 'cancelled'
      and coalesce(cs.ends_on, v_today) >= v_today
  ),
  people as (
    select a.instructor_id, array_agg(distinct a.site order by a.site) as sites
    from assigned a
    group by a.instructor_id
  )
  select
    i.id,
    i.first_name,
    i.last_name,
    pp.sites,
    (i.partner_sharing_agreed_at is not null),
    case when i.partner_sharing_agreed_at is not null then i.email end,
    case when i.partner_sharing_agreed_at is not null then i.phone end,
    case when i.partner_sharing_agreed_at is not null and s.checkr_status = 'clear'
      then s.background_check_completed_on end,
    case when i.partner_sharing_agreed_at is not null and s.checkr_status = 'clear' and v_months > 0
      then (s.background_check_completed_on + make_interval(months => v_months))::date end,
    case when i.partner_sharing_agreed_at is null then 'in_review'
         when s.checkr_status in ('pending', 'invited', 'processing') then 'in_review'
         when s.checkr_status is distinct from 'clear' then 'missing'
         when s.background_check_completed_on is null then 'awaiting_date'
         when v_months = 0 then private.document_expiry_status(null, v_org)
         else private.document_expiry_status(
           (s.background_check_completed_on + make_interval(months => v_months))::date, v_org)
    end,
    case when i.partner_sharing_agreed_at is not null then s.background_check_vendor end,
    case when i.partner_sharing_agreed_at is not null then s.background_check_entered_at::date end,
    case when i.partner_sharing_agreed_at is not null then i.training_completed_on end,
    case when i.partner_sharing_agreed_at is not null then i.training_entered_at::date end,
    case when i.partner_sharing_agreed_at is not null then (
      select max(k.acknowledged_at)::date from public.contractor_acknowledgments k
      where k.instructor_id = i.id and k.organization_id = v_org and k.document_id = 'code_of_conduct') end,
    case when i.partner_sharing_agreed_at is not null then (
      select max(k.acknowledged_at)::date from public.contractor_acknowledgments k
      where k.instructor_id = i.id and k.organization_id = v_org and k.document_id = 'mandatory_reporter_ack') end,
    case when i.partner_sharing_agreed_at is not null then (
      select max(g.signed_at)::date from public.contractor_agreements g
      where g.instructor_id = i.id and g.organization_id = v_org) end
  from people pp
  join public.instructors i on i.id = pp.instructor_id and i.organization_id = v_org
  left join public.contractor_onboarding_status s
    on s.instructor_id = i.id and s.organization_id = v_org
  where i.is_active
  order by i.last_name, i.first_name;
end;
$function$;

commit;
