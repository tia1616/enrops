-- Invites: a partner (host) invites an outside provider to share its safety
-- record (spec v3 H4 and P1; Nov 6 checks 1-4). Built OFF: Arielle 2026-10-28
-- "invites stay off for partners until end of winter". The switch is
-- platform_settings 'partner_invites' {"enabled": false}; nothing below sends,
-- shows or accepts while it is off.
--
-- MODEL (Jessica 2026-11-04: "reuse today's logins"). A host is still a
-- partner row of some provider, and a host person is a partner login. An
-- invitation hangs off the inviting partner row and the inviting login. When an
-- invited provider accepts, enrops gives THAT provider its own partner row for
-- the host (or reuses one of the same name), a contact for the inviting
-- person, and a host_admin login for them; that login claims itself on the
-- person's next sign-in by email (partner_portal_memberships), exactly as every
-- partner login does. The host's partner home then lists both providers. The
-- inviting row's requirement list and wording are copied in as a starting
-- point, and the new provider owns its copy.
--
-- STATES (spec v3 Invitation): saved (on the host's list, not sent), sent,
-- opened, accepted, declined, expired. expires_at = 30 days after sending.
-- Day-3 and day-7 reminders are stamped by the sender function.
--
-- TOKEN. The link carries a random token; only its SHA-256 is stored, so the
-- table never holds a usable link. Preview, accept and decline take the token.
--
-- CONSENT is the accept itself: the provider ticks "Share my record's status
-- with {host}" (never pre-ticked) and an owner or admin of the provider
-- accepts. Until then the host sees nothing of that provider: no partner row,
-- no login, so every existing portal rule keeps it invisible.
--
-- Grants explicit (Supabase 2026-10-30 change). No client writes to the table.

insert into public.platform_settings (key, value)
values ('partner_invites', '{"enabled": false}'::jsonb)
on conflict (key) do nothing;

-- Whether invites are on. Readable by anyone signed in (platform_settings
-- itself is platform-admin only).
create or replace function public.partner_invites_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select (s.value ->> 'enabled')::boolean from public.platform_settings s where s.key = 'partner_invites'), false);
$$;
revoke all on function public.partner_invites_enabled() from public, anon;
grant execute on function public.partner_invites_enabled() to authenticated, service_role;

create table if not exists public.partner_invitations (
  id                      uuid primary key default gen_random_uuid(),
  partner_id              uuid not null references public.partners(id) on delete cascade,
  from_organization_id    uuid not null references public.organizations(id) on delete cascade,
  invited_by_access_id    uuid references public.partner_portal_access(id) on delete set null,
  invited_by_user_id      uuid not null,
  host_name               text not null,
  inviter_name            text,
  inviter_email           text not null,
  invited_email           text not null,
  business_name_as_typed  text not null,
  message                 text,
  state                   text not null default 'saved',
  -- Every link this invitation has had (the first send and each reminder),
  -- as SHA-256 hashes; any of them opens it, so an older email still works.
  token_hashes            text[] not null default '{}',
  created_at              timestamptz not null default now(),
  sent_at                 timestamptz,
  opened_at               timestamptz,
  accepted_at             timestamptz,
  declined_at             timestamptz,
  declined_note           text,
  reminder_1_at           timestamptz,
  reminder_2_at           timestamptz,
  expires_at              timestamptz,
  accepted_organization_id uuid references public.organizations(id) on delete set null,
  accepted_partner_id     uuid references public.partners(id) on delete set null,
  constraint partner_invitations_state_check check (state in ('saved', 'sent', 'opened', 'accepted', 'declined', 'expired')),
  constraint partner_invitations_email_check check (invited_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  constraint partner_invitations_name_check check (char_length(btrim(business_name_as_typed)) between 1 and 120),
  constraint partner_invitations_message_check check (message is null or char_length(message) <= 1000),
  constraint partner_invitations_note_check check (declined_note is null or char_length(declined_note) <= 500)
);
create index if not exists partner_invitations_partner on public.partner_invitations (partner_id, created_at desc);
create index if not exists partner_invitations_tokens on public.partner_invitations using gin (token_hashes);

alter table public.partner_invitations enable row level security;
revoke all on public.partner_invitations from public, anon, authenticated;
grant all on public.partner_invitations to service_role;

comment on table public.partner_invitations is
  'A host''s invitations to outside providers (spec v3 H4). Written by partner-invites (send/save) and accept_/decline_partner_invitation; read by partner_invitations_for().';

-- ONE place for a partner's requirement list with defaults applied (it was
-- inside partner_requirements_for, 20261104b). No access check here: callers
-- check. partner_requirements_for keeps its access rule and now reads this,
-- and the invite preview reads it to show the categories the host will see.
create or replace function private.partner_requirements_list(p_partner_id uuid)
returns table (requirement_key text, required boolean, detail text, source text)
language sql
stable
security definer
set search_path = ''
as $$
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
  select d.requirement_key, coalesce(r.required, d.required), x.detail, x.source
  from defaults d
  left join public.partner_requirements r
    on r.partner_id = p_partner_id and r.requirement_key = d.requirement_key
  left join public.partner_requirement_details x
    on x.partner_id = p_partner_id and x.requirement_key = d.requirement_key
  order by d.sort;
$$;
revoke all on function private.partner_requirements_list(uuid) from public, anon, authenticated;

create or replace function public.partner_requirements_for(p_partner_id uuid)
returns table (requirement_key text, required boolean, detail text, source text)
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
  return query select * from private.partner_requirements_list(p_partner_id);
end;
$$;
revoke all on function public.partner_requirements_for(uuid) from public, anon;
grant execute on function public.partner_requirements_for(uuid) to authenticated, service_role;

-- The host's own list (H4 "List of invitations with state and dates"): that
-- partner's logins only. Never the token.
create or replace function public.partner_invitations_for(p_partner_id uuid)
returns table (
  id uuid, business_name text, invited_email text, state text, created_at timestamptz,
  sent_at timestamptz, opened_at timestamptz, accepted_at timestamptz, declined_at timestamptz,
  declined_note text, expires_at timestamptz, inviter_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.business_name_as_typed, i.invited_email, i.state, i.created_at,
         i.sent_at, i.opened_at, i.accepted_at, i.declined_at, i.declined_note, i.expires_at, i.inviter_name
  from public.partner_invitations i
  where i.partner_id = p_partner_id
    and exists (select 1 from private.current_partner_access() a where a.partner_id = p_partner_id)
  order by i.created_at desc;
$$;
revoke all on function public.partner_invitations_for(uuid) from public, anon;
grant execute on function public.partner_invitations_for(uuid) to authenticated, service_role;

-- What the invite link shows before signing in (P1 header and categories).
-- Anyone holding the token may read the host's name and the categories; the
-- first look stamps opened_at. Returns nothing for an unknown, expired or
-- finished invitation, or when invites are off.
create or replace function public.partner_invitation_preview(p_token text)
returns table (host_name text, business_name text, invited_email text, state text, expires_at timestamptz, categories text[])
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.partner_invitations;
begin
  if not public.partner_invites_enabled() or p_token is null or char_length(p_token) < 32 then
    return;
  end if;
  select * into v from public.partner_invitations i
  where encode(extensions.digest(p_token, 'sha256'), 'hex') = any(i.token_hashes);
  if v.id is null or v.state not in ('sent', 'opened') then
    return;
  end if;
  if v.expires_at is not null and v.expires_at < now() then
    update public.partner_invitations set state = 'expired' where id = v.id;
    return;
  end if;
  if v.state = 'sent' then
    update public.partner_invitations set state = 'opened', opened_at = now() where id = v.id;
  end if;
  return query
  select v.host_name, v.business_name_as_typed, v.invited_email, 'opened'::text, v.expires_at,
         array(select r.requirement_key from private.partner_requirements_list(v.partner_id) r where r.required);
end;
$$;
revoke all on function public.partner_invitation_preview(text) from public;
grant execute on function public.partner_invitation_preview(text) to anon, authenticated, service_role;

-- Accept (P1 "Share with {host}"). The caller must be an owner or admin of
-- p_org and must have ticked consent (p_consent). Creates or reuses the host's
-- partner row in p_org, a contact for the inviting person, their host_admin
-- login, and copies the inviting row's requirements. Returns the partner id.
create or replace function public.accept_partner_invitation(p_token text, p_org uuid, p_consent boolean)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.partner_invitations;
  v_partner uuid;
  v_contact uuid;
  v_type text;
begin
  if not public.partner_invites_enabled() then
    raise exception 'Invitations are not open yet' using errcode = 'PI001';
  end if;
  if p_consent is not true then
    raise exception 'Tick the box to share your record' using errcode = 'PI002';
  end if;
  if p_org is null or not public.can_admin_org(p_org) then
    raise exception 'Only an owner or admin of the business can accept' using errcode = 'PI003';
  end if;
  select * into v from public.partner_invitations i
  where encode(extensions.digest(p_token, 'sha256'), 'hex') = any(i.token_hashes)
  for update;
  if v.id is null or v.state not in ('sent', 'opened') then
    raise exception 'This invitation is no longer open' using errcode = 'PI004';
  end if;
  if v.expires_at is not null and v.expires_at < now() then
    update public.partner_invitations set state = 'expired' where id = v.id;
    raise exception 'This invitation has expired' using errcode = 'PI005';
  end if;
  if p_org = v.from_organization_id then
    raise exception 'This invitation is from your own partner' using errcode = 'PI006';
  end if;

  select p.partner_type into v_type from public.partners p where p.id = v.partner_id;
  -- One partner row per name per provider (partners UNIQUE): reuse it.
  select p.id into v_partner from public.partners p where p.organization_id = p_org and p.partner_name = v.host_name;
  if v_partner is null then
    insert into public.partners (organization_id, partner_name, partner_type, source)
    values (p_org, v.host_name, v_type, 'partner_invitation')
    returning id into v_partner;
  end if;

  select c.id into v_contact from public.partner_contacts c
  where c.partner_id = v_partner and lower(btrim(c.contact_email::text)) = lower(btrim(v.inviter_email))
  limit 1;
  if v_contact is null then
    insert into public.partner_contacts (organization_id, partner_id, contact_name, contact_email, contact_role, source)
    values (p_org, v_partner, v.inviter_name, v.inviter_email, 'operational', 'partner_invitation')
    returning id into v_contact;
  end if;
  insert into public.partner_portal_access (organization_id, partner_id, contact_id, role)
  values (p_org, v_partner, v_contact, 'host_admin')
  on conflict (contact_id) do nothing;

  -- The inviting row's list and wording, as a starting point the provider owns.
  insert into public.partner_requirements (partner_id, organization_id, requirement_key, required, updated_at, updated_by)
  select v_partner, p_org, r.requirement_key, r.required, now(), auth.uid()
  from public.partner_requirements r where r.partner_id = v.partner_id
  on conflict (partner_id, requirement_key) do nothing;
  insert into public.partner_requirement_details (partner_id, organization_id, requirement_key, detail, source, updated_at, updated_by)
  select v_partner, p_org, x.requirement_key, x.detail, x.source, now(), auth.uid()
  from public.partner_requirement_details x where x.partner_id = v.partner_id
  on conflict (partner_id, requirement_key) do nothing;

  update public.partner_invitations
     set state = 'accepted', accepted_at = now(), accepted_organization_id = p_org, accepted_partner_id = v_partner
   where id = v.id;

  insert into public.audit_events (organization_id, partner_id, actor_user_id, actor_role, action, subject_type, subject_id, after)
  values (p_org, v_partner, auth.uid(), 'provider_admin', 'invitation_accepted', 'partner_invitation', v.id,
          jsonb_build_object('host_name', v.host_name, 'from_partner_id', v.partner_id));
  return v_partner;
end;
$$;
revoke all on function public.accept_partner_invitation(text, uuid, boolean) from public, anon;
grant execute on function public.accept_partner_invitation(text, uuid, boolean) to authenticated, service_role;

-- "Not now" with an optional note to the host. Anyone holding the token.
create or replace function public.decline_partner_invitation(p_token text, p_note text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.partner_invites_enabled() or p_token is null then
    return false;
  end if;
  update public.partner_invitations i
     set state = 'declined', declined_at = now(),
         declined_note = left(nullif(btrim(coalesce(p_note, '')), ''), 500)
   where encode(extensions.digest(p_token, 'sha256'), 'hex') = any(i.token_hashes)
     and i.state in ('sent', 'opened')
     and (i.expires_at is null or i.expires_at >= now())
  returning i.id into v_id;
  return v_id is not null;
end;
$$;
revoke all on function public.decline_partner_invitation(text, text) from public;
grant execute on function public.decline_partner_invitation(text, text) to anon, authenticated, service_role;
