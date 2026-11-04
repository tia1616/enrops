-- Vendor-agnostic safety record (spec v3 Nov 6 checks 10 and 11).
--
-- 1. WHERE A PROVIDER REGISTERS FAMILIES. provider_record_settings holds the
--    provider's registration system (spec v3 Provider.registration_system), so a
--    host sees it as plain text and a provider who registers families anywhere
--    can still keep a full record. Its own table, not a column on organizations,
--    so the money guard's measured column set on organizations is untouched.
--
-- 2. A STATUS FROM ANOTHER SOURCE. instructor_clearances holds checks the
--    provider entered from outside enrops: a district fingerprint clearance, the
--    Oregon Central Background Registry, a Washington DCYF portable check (J2S
--    works in Vancouver and Camas, WA), a check run by a screening company, or
--    another agency. Only bodies where J2S works today (Jessica 2026-11-04: "we
--    don't do texas"); a new one is added when a provider needs it. Each row is a status only (spec v3 §1.6): who cleared, what kind,
--    scope, completed and expiry dates. Never a report.
--
--    NAMING (Jessica 2026-11-03, on Arielle's 10/28 rule "Keep the screening
--    vendor's name off every screen and email"): public clearance bodies are
--    named to hosts; a screening COMPANY never is. So 'screening_company' has
--    no name field at all, and clearance_body_other (an agency's name) is
--    allowed only with 'other'.
--
--    A row's status follows the documents' rule (private.document_expiry_status):
--    current until 30 days before its expiry, then expiring, then expired; no
--    expiry entered = current.
--
-- ACCESS. Both tables are read by the provider's members and by that provider's
-- partner logins; partners read clearances only for instructors their portal
-- already shows them as SHARED (partner_portal_clearances goes through
-- partner_portal_instructors, which applies consent and the login's sites).
-- Writes go through SECURITY DEFINER functions, owner/admin only, each
-- appending to audit_events. Grants explicit (Supabase 2026-10-30 change).

-- 1 -------------------------------------------------------------------------
create table if not exists public.provider_record_settings (
  organization_id            uuid primary key references public.organizations(id) on delete cascade,
  registration_system        text,
  registration_system_other  text,
  updated_at                 timestamptz not null default now(),
  updated_by                 uuid,
  constraint provider_record_settings_system_check check (registration_system in (
    'enrops', 'jackrabbit', 'sawyer', 'active', 'amilia', 'facilitron', 'jumbula',
    'coursestorm', 'own_website', 'paper', 'other'
  )),
  constraint provider_record_settings_other_check check (
    (registration_system = 'other' and char_length(btrim(coalesce(registration_system_other, ''))) between 1 and 80)
    or (registration_system is distinct from 'other' and registration_system_other is null)
  )
);

alter table public.provider_record_settings enable row level security;
revoke all on public.provider_record_settings from public, anon, authenticated;
grant select on public.provider_record_settings to authenticated;
grant all on public.provider_record_settings to service_role;

drop policy if exists provider_record_settings_select on public.provider_record_settings;
create policy provider_record_settings_select on public.provider_record_settings
  for select to authenticated
  using (
    public.is_org_member(organization_id)
    or exists (select 1 from private.current_partner_access() a where a.organization_id = provider_record_settings.organization_id)
  );

comment on table public.provider_record_settings is
  'Provider-level safety record settings (where it registers families). Written by set_registration_system().';

create or replace function public.set_registration_system(p_org uuid, p_system text, p_other text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before text;
  v_other text := case when p_system = 'other' then nullif(btrim(coalesce(p_other, '')), '') end;
begin
  if p_org is null or not public.can_admin_org(p_org) then
    return false;
  end if;
  select s.registration_system into v_before from public.provider_record_settings s where s.organization_id = p_org;
  insert into public.provider_record_settings (organization_id, registration_system, registration_system_other, updated_at, updated_by)
  values (p_org, p_system, v_other, now(), auth.uid())
  on conflict (organization_id) do update
    set registration_system = excluded.registration_system,
        registration_system_other = excluded.registration_system_other,
        updated_at = now(), updated_by = auth.uid();
  insert into public.audit_events (organization_id, actor_user_id, actor_role, action, subject_type, before, after)
  values (p_org, auth.uid(), 'provider_admin', 'registration_system_set', 'provider_record_settings',
          jsonb_build_object('registration_system', v_before),
          jsonb_build_object('registration_system', p_system, 'other', v_other));
  return true;
end;
$$;
revoke all on function public.set_registration_system(uuid, text, text) from public, anon;
grant execute on function public.set_registration_system(uuid, text, text) to authenticated, service_role;

-- 2 -------------------------------------------------------------------------
create table if not exists public.instructor_clearances (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  instructor_id         uuid not null references public.instructors(id) on delete cascade,
  check_type            text not null,
  clearance_body        text not null,
  clearance_body_other  text,
  -- Training only (spec v3 P5: "training name, who gave it, completed,
  -- expires"): the training's name. Who gave it is the clearance body.
  item_name             text,
  scope                 text,
  completed_on          date not null,
  expires_on            date,
  entered_by            uuid,
  entered_at            timestamptz not null default now(),
  constraint instructor_clearances_type_check check (check_type in (
    'background_check', 'fingerprint_clearance', 'registry_check', 'training', 'other'
  )),
  constraint instructor_clearances_item_name_check check (
    (check_type = 'training' and char_length(btrim(coalesce(item_name, ''))) between 1 and 120)
    or (check_type <> 'training' and item_name is null)
  ),
  constraint instructor_clearances_body_check check (clearance_body in (
    'district_fingerprint', 'oregon_cbr', 'wa_dcyf', 'screening_company', 'other'
  )),
  constraint instructor_clearances_body_other_check check (
    (clearance_body = 'other' and char_length(btrim(coalesce(clearance_body_other, ''))) between 1 and 80)
    or (clearance_body <> 'other' and clearance_body_other is null)
  ),
  constraint instructor_clearances_scope_check check (scope is null or char_length(scope) <= 200),
  constraint instructor_clearances_dates_check check (expires_on is null or expires_on >= completed_on)
);
create index if not exists instructor_clearances_instructor on public.instructor_clearances (instructor_id);

alter table public.instructor_clearances enable row level security;
revoke all on public.instructor_clearances from public, anon, authenticated;
grant select on public.instructor_clearances to authenticated;
grant all on public.instructor_clearances to service_role;

-- The provider's own team reads its instructors' clearances directly (the
-- instructor record). Partners read only through partner_portal_clearances().
drop policy if exists instructor_clearances_member_select on public.instructor_clearances;
create policy instructor_clearances_member_select on public.instructor_clearances
  for select to authenticated
  using (public.is_org_member(organization_id));

comment on table public.instructor_clearances is
  'Instructor statuses entered from another source (district fingerprint, Oregon CBR, WA DCYF, a screening company, another agency). Status only, never a report. Written by add_/remove_instructor_clearance().';

-- (Staging briefly had a version without p_item_name; drop it so no stale
-- overload remains.)
drop function if exists public.add_instructor_clearance(uuid, text, text, text, text, date, date);
create or replace function public.add_instructor_clearance(
  p_instructor_id uuid,
  p_check_type text,
  p_clearance_body text,
  p_clearance_body_other text,
  p_item_name text,
  p_scope text,
  p_completed_on date,
  p_expires_on date
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_id uuid;
begin
  select i.organization_id into v_org from public.instructors i where i.id = p_instructor_id;
  if v_org is null or not public.can_admin_org(v_org) then
    raise exception 'Only an owner or admin can add a clearance' using errcode = 'IC001';
  end if;
  insert into public.instructor_clearances (
    organization_id, instructor_id, check_type, clearance_body, clearance_body_other,
    item_name, scope, completed_on, expires_on, entered_by
  ) values (
    v_org, p_instructor_id, p_check_type, p_clearance_body,
    case when p_clearance_body = 'other' then nullif(btrim(coalesce(p_clearance_body_other, '')), '') end,
    case when p_check_type = 'training' then nullif(btrim(coalesce(p_item_name, '')), '') end,
    nullif(btrim(coalesce(p_scope, '')), ''), p_completed_on, p_expires_on, auth.uid()
  )
  returning id into v_id;
  insert into public.audit_events (organization_id, actor_user_id, actor_role, action, subject_type, subject_id, after)
  values (v_org, auth.uid(), 'provider_admin', 'clearance_added', 'instructor_clearance', v_id,
          jsonb_build_object('instructor_id', p_instructor_id, 'check_type', p_check_type,
                             'clearance_body', p_clearance_body, 'item_name', p_item_name,
                             'completed_on', p_completed_on, 'expires_on', p_expires_on));
  return v_id;
end;
$$;
revoke all on function public.add_instructor_clearance(uuid, text, text, text, text, text, date, date) from public, anon;
grant execute on function public.add_instructor_clearance(uuid, text, text, text, text, text, date, date) to authenticated, service_role;

create or replace function public.remove_instructor_clearance(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.instructor_clearances;
begin
  select * into v_row from public.instructor_clearances c where c.id = p_id;
  if v_row.id is null or not public.can_admin_org(v_row.organization_id) then
    return false;
  end if;
  delete from public.instructor_clearances c where c.id = p_id;
  insert into public.audit_events (organization_id, actor_user_id, actor_role, action, subject_type, subject_id, before)
  values (v_row.organization_id, auth.uid(), 'provider_admin', 'clearance_removed', 'instructor_clearance', p_id,
          jsonb_build_object('instructor_id', v_row.instructor_id, 'check_type', v_row.check_type,
                             'clearance_body', v_row.clearance_body, 'completed_on', v_row.completed_on, 'expires_on', v_row.expires_on));
  return true;
end;
$$;
revoke all on function public.remove_instructor_clearance(uuid) from public, anon;
grant execute on function public.remove_instructor_clearance(uuid) to authenticated, service_role;

-- What a partner (or the provider viewing that partner's page) sees: clearances
-- of the instructors partner_portal_instructors shows for that partner, only
-- for those who agreed to share. Never entered_by, never a company's name.
drop function if exists public.partner_portal_clearances(uuid);
create function public.partner_portal_clearances(p_partner_id uuid)
returns table (
  id uuid,
  instructor_id uuid,
  check_type text,
  clearance_body text,
  clearance_body_other text,
  item_name text,
  scope text,
  completed_on date,
  expires_on date,
  entered_at timestamptz,
  status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.instructor_id, c.check_type, c.clearance_body, c.clearance_body_other,
         c.item_name, c.scope, c.completed_on, c.expires_on, c.entered_at,
         private.document_expiry_status(c.expires_on, c.organization_id)
  from public.partner_portal_instructors(p_partner_id) i
  join public.instructor_clearances c on c.instructor_id = i.instructor_id
  where i.shared
  order by c.completed_on desc;
$$;
revoke all on function public.partner_portal_clearances(uuid) from public, anon;
grant execute on function public.partner_portal_clearances(uuid) to authenticated, service_role;
