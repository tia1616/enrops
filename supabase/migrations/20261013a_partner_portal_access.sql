-- Partner portal, chunk 2: partner logins.
--
-- A person at a partner (a parks department, a school) signs in with a magic
-- link and sees the documents the provider has shown to that partner. They are
-- NOT org_members: an org_members row would pass every admin RLS policy in the
-- product. Partner access is its own table and its own policies.
--
-- WHO. Access is granted to an existing partner CONTACT (partner_contacts), so
-- the person's name and email live in exactly one place. This table holds only
-- the grant and the link to the person's auth account once they sign in.
--
-- WHY NOT A COLUMN ON partner_contacts. That table's policy lets ANY org member
-- (staff and viewer included) write any column. Granting a city access to the
-- provider's insurance and background-check record is an owner/admin decision,
-- so the grant needs owner/admin-only policies of its own.
--
-- LINKING. The first time the person signs in, partner_portal_memberships()
-- links the grant to their auth user by matching the contact's email to the
-- signed-in account's (confirmed) email. If the contact's email is later
-- changed, the link is cleared, so the old address's account loses access and
-- the new address claims it on its next sign-in.
--
-- Additive: one new table, two functions, one new policy on provider_documents,
-- one AFTER UPDATE trigger on partner_contacts that only ever touches this table.

begin;

create table if not exists public.partner_portal_access (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  partner_id         uuid not null references public.partners(id) on delete cascade,
  contact_id         uuid not null unique references public.partner_contacts(id) on delete cascade,
  -- Set on first sign-in by partner_portal_memberships(); cleared when the
  -- contact's email changes.
  auth_user_id       uuid references auth.users(id) on delete set null,
  last_link_sent_at  timestamptz,
  last_signed_in_at  timestamptz,
  granted_by         uuid,
  created_at         timestamptz not null default now()
);

create index if not exists partner_portal_access_auth_idx
  on public.partner_portal_access (auth_user_id) where auth_user_id is not null;
create index if not exists partner_portal_access_org_idx
  on public.partner_portal_access (organization_id);

alter table public.partner_portal_access enable row level security;

-- organization_id and partner_id come from the contact, never from the writer,
-- and granted_by is the caller.
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
  return new;
end;
$function$;

revoke all on function public.guard_partner_portal_access() from public, anon, authenticated;

drop trigger if exists partner_portal_access_guard on public.partner_portal_access;
create trigger partner_portal_access_guard
  before insert on public.partner_portal_access
  for each row execute function public.guard_partner_portal_access();

-- A changed email unlinks the old account. AFTER UPDATE OF contact_email only,
-- and it writes nothing but this table.
create or replace function public.unlink_partner_portal_on_email_change()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if lower(coalesce(btrim(new.contact_email), '')) is distinct from lower(coalesce(btrim(old.contact_email), '')) then
    update public.partner_portal_access
       set auth_user_id = null
     where contact_id = new.id;
  end if;
  return null;
end;
$function$;

revoke all on function public.unlink_partner_portal_on_email_change() from public, anon, authenticated;

drop trigger if exists partner_contacts_unlink_portal on public.partner_contacts;
create trigger partner_contacts_unlink_portal
  after update of contact_email on public.partner_contacts
  for each row execute function public.unlink_partner_portal_on_email_change();

-- Policies. The provider's team sees who has access; owners/admins grant and
-- remove it. A signed-in partner sees their own grant. No client UPDATE: the
-- link and timestamps are written by definer functions / the sign-in edge fn.
drop policy if exists partner_portal_access_member_select on public.partner_portal_access;
create policy partner_portal_access_member_select on public.partner_portal_access
  for select to authenticated
  using (public.is_org_member(organization_id) or public.is_platform_admin() or auth_user_id = auth.uid());

drop policy if exists partner_portal_access_admin_insert on public.partner_portal_access;
create policy partner_portal_access_admin_insert on public.partner_portal_access
  for insert to authenticated
  with check (public.can_admin_org(organization_id));

drop policy if exists partner_portal_access_admin_delete on public.partner_portal_access;
create policy partner_portal_access_admin_delete on public.partner_portal_access
  for delete to authenticated
  using (public.can_admin_org(organization_id));

revoke all on public.partner_portal_access from public, anon, authenticated;
grant select, insert, delete on public.partner_portal_access to authenticated;

-- The signed-in person's partner grants, for RLS. An archived partner grants
-- nothing. SECURITY DEFINER so the check does not depend on the partner's own
-- read access to partners.
create or replace function private.current_partner_access()
returns table (partner_id uuid, organization_id uuid)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select a.partner_id, a.organization_id
  from public.partner_portal_access a
  join public.partners p on p.id = a.partner_id
  where a.auth_user_id = auth.uid()
    and auth.uid() is not null
    and coalesce(p.inactive, false) = false;
$function$;

revoke all on function private.current_partner_access() from public, anon;
grant execute on function private.current_partner_access() to authenticated;

-- A partner reads the documents shown to every partner of that provider, plus
-- those shown to their own partner. (The storage read policy keys on "a row
-- exists that the caller can read", so this also lets them open the file.)
drop policy if exists provider_documents_partner_select on public.provider_documents;
create policy provider_documents_partner_select on public.provider_documents
  for select to authenticated
  using (
    exists (
      select 1 from private.current_partner_access() a
      where a.organization_id = provider_documents.organization_id
        and (provider_documents.partner_id is null or provider_documents.partner_id = a.partner_id)
    )
  );

-- Called by the partner portal on load. Links any unclaimed grant whose
-- contact email matches the signed-in account's confirmed email, stamps the
-- sign-in time, and returns what this person can see. Never returns another
-- person's grant: every row is keyed to auth.uid().
create or replace function public.partner_portal_memberships()
returns table (
  partner_id uuid,
  partner_name text,
  organization_id uuid,
  organization_name text,
  organization_slug text
)
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_email text;
begin
  if v_uid is null then
    return;
  end if;

  select lower(btrim(u.email)) into v_email
  from auth.users u
  where u.id = v_uid and u.email_confirmed_at is not null;

  if v_email is not null then
    update public.partner_portal_access a
       set auth_user_id = v_uid
      from public.partner_contacts c
     where c.id = a.contact_id
       and a.auth_user_id is null
       and lower(btrim(c.contact_email)) = v_email;
  end if;

  update public.partner_portal_access
     set last_signed_in_at = now()
   where auth_user_id = v_uid;

  return query
    select p.id, p.partner_name, o.id, o.name, o.slug
    from public.partner_portal_access a
    join public.partners p on p.id = a.partner_id
    join public.organizations o on o.id = a.organization_id
    where a.auth_user_id = v_uid
      and coalesce(p.inactive, false) = false
    order by o.name, p.partner_name;
end;
$function$;

revoke all on function public.partner_portal_memberships() from public, anon;
grant execute on function public.partner_portal_memberships() to authenticated;

commit;
