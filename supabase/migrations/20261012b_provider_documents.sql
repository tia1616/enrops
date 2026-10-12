-- Provider documents: the papers a provider keeps on file for its partners
-- (certificate of insurance, the partner agreement, anything a partner's own
-- agreement adds). Partner portal, chunk 1 of the Oct 30 goal: a partner logs
-- in and sees the provider's vendor record. This chunk is the record and the
-- admin entry screen only; nothing here is visible to a partner yet.
--
-- WHAT IS NOT IN THIS TABLE, ON PURPOSE. Background checks, training and CPR
-- are per INSTRUCTOR and already live where they are recorded:
-- contractor_onboarding_status (background_check_file_url / _completed_on),
-- the training tables, instructors.first_aid_cpr_*. The partner view reads them
-- there. A second copy here would be a second spelling of each fact.
--
-- SHOWN TO. partner_id NULL = every partner of this provider sees it.
-- partner_id set = only that partner. A certificate of insurance is usually
-- made out to one city (the certificate holder differs per partner), so most
-- insurance rows are partner-specific.
--
-- EXPIRY STATUS LIVES IN ONE PLACE: private.document_expiry_status(). The admin
-- screen reads it through provider_documents_with_status; the partner view and
-- the expiry-alert job will call the same function, so "expiring soon" can
-- never mean two different things.
--
-- PRIVATE BUCKET. Files are read through short-lived signed URLs. The storage
-- SELECT policy is "a provider_documents row exists for this path that the
-- caller can read", evaluated under the caller's own RLS, so the table policy
-- is the single read decision (the same shape as class-photos). Uploads happen
-- before the row exists, so INSERT is scoped by the org folder instead.
--
-- Additive and inert: no existing table, view or function changes.

begin;

create table if not exists public.provider_documents (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  -- NULL = shown to every partner of this provider.
  partner_id         uuid references public.partners(id) on delete cascade,
  doc_type           text not null,
  title              text not null,
  received_on        date,
  effective_on       date,
  -- NULL only when the admin said the document has no expiry date. Insurance
  -- always has one (constraint below).
  expires_on         date,
  storage_path       text not null unique,
  original_filename  text,
  -- Insurance details. Only meaningful when doc_type = 'insurance'.
  insurer            text,
  policy_number      text,
  abuse_coverage     boolean,
  coverage_notes     text,
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint provider_documents_doc_type_check
    check (doc_type in ('insurance', 'agreement', 'other')),
  constraint provider_documents_title_present
    check (length(btrim(title)) > 0),
  constraint provider_documents_insurance_expires
    check (doc_type <> 'insurance' or expires_on is not null),
  constraint provider_documents_dates_ordered
    check (effective_on is null or expires_on is null or expires_on >= effective_on),
  -- A row may only point at an object inside ITS OWN provider's folder.
  -- Without this an admin of one provider could write a row carrying another
  -- provider's object path, and the storage SELECT policy (which keys on "a row
  -- exists for this path") would then sign that file for them.
  constraint provider_documents_path_in_own_org
    check (storage_path like organization_id::text || '/%')
);

create index if not exists provider_documents_org_idx
  on public.provider_documents (organization_id, expires_on);
create index if not exists provider_documents_partner_idx
  on public.provider_documents (partner_id) where partner_id is not null;

alter table public.provider_documents enable row level security;

-- A partner-specific row must name a partner of the SAME provider, and
-- updated_at is maintained here rather than trusted from the client.
create or replace function public.guard_provider_documents()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.partner_id is not null and not exists (
    select 1 from public.partners p
    where p.id = new.partner_id and p.organization_id = new.organization_id
  ) then
    raise exception 'provider_documents: that partner does not belong to this provider'
      using errcode = '23503';
  end if;
  if tg_op = 'UPDATE' then
    if new.organization_id <> old.organization_id then
      raise exception 'provider_documents: a document cannot move to another provider'
        using errcode = '42501';
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$function$;

-- A trigger function needs no caller EXECUTE.
revoke all on function public.guard_provider_documents() from public, anon, authenticated;

drop trigger if exists provider_documents_guard on public.provider_documents;
create trigger provider_documents_guard
  before insert or update on public.provider_documents
  for each row execute function public.guard_provider_documents();

-- Table policies. The provider's team reads its own documents; owners and
-- admins add, edit and delete them (workspace-level, like the rest of Settings).
-- The partner read policy arrives with partner logins (chunk 2).
drop policy if exists provider_documents_member_select on public.provider_documents;
create policy provider_documents_member_select on public.provider_documents
  for select to authenticated
  using (public.is_org_member(organization_id) or public.is_platform_admin());

drop policy if exists provider_documents_admin_insert on public.provider_documents;
create policy provider_documents_admin_insert on public.provider_documents
  for insert to authenticated
  with check (public.can_admin_org(organization_id));

drop policy if exists provider_documents_admin_update on public.provider_documents;
create policy provider_documents_admin_update on public.provider_documents
  for update to authenticated
  using (public.can_admin_org(organization_id))
  with check (public.can_admin_org(organization_id));

drop policy if exists provider_documents_admin_delete on public.provider_documents;
create policy provider_documents_admin_delete on public.provider_documents
  for delete to authenticated
  using (public.can_admin_org(organization_id));

revoke all on public.provider_documents from public, anon, authenticated;
grant select, insert, update, delete on public.provider_documents to authenticated;

-- The one definition of a document's expiry status, in the provider's own
-- timezone. 'expiring_soon' = within 30 days, which is also the first alert.
-- SECURITY DEFINER so it can read organizations.timezone for a caller (a
-- partner, later) who has no read access to organizations.
create or replace function private.document_expiry_status(p_expires_on date, p_org uuid)
returns text
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with today as (
    select (now() at time zone coalesce(
      (select o.timezone from public.organizations o where o.id = p_org),
      'America/Los_Angeles'))::date as d
  )
  select case
    when p_expires_on is null then 'no_expiry'
    when p_expires_on < (select d from today) then 'expired'
    when p_expires_on <= (select d from today) + 30 then 'expiring_soon'
    else 'current'
  end;
$function$;

revoke all on function private.document_expiry_status(date, uuid) from public, anon;
grant execute on function private.document_expiry_status(date, uuid) to authenticated;

-- Rows plus their status. security_invoker so the caller's own RLS on
-- provider_documents decides which rows come back.
create or replace view public.provider_documents_with_status
with (security_invoker = on) as
  select d.*,
         private.document_expiry_status(d.expires_on, d.organization_id) as expiry_status
  from public.provider_documents d;

revoke all on public.provider_documents_with_status from public, anon, authenticated;
grant select on public.provider_documents_with_status to authenticated;

-- The private bucket. 10 MB, PDF or a photo of the paper.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('provider-documents', 'provider-documents', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

drop policy if exists provider_documents_storage_select on storage.objects;
create policy provider_documents_storage_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'provider-documents'
    and exists (select 1 from public.provider_documents d where d.storage_path = name)
  );

-- CASE, not AND: Postgres does not promise to test bucket_id first, and these
-- policies are evaluated for every bucket's objects. A plain AND could try the
-- uuid cast on another bucket's path (e.g. 'logos/x.png') and raise instead of
-- returning false. CASE fixes the order; the regex keeps a malformed path in
-- THIS bucket a refusal rather than an error.
drop policy if exists provider_documents_storage_insert on storage.objects;
create policy provider_documents_storage_insert on storage.objects
  for insert to authenticated
  with check (
    case when bucket_id = 'provider-documents'
          and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.can_admin_org(((storage.foldername(name))[1])::uuid)
      else false
    end
  );

drop policy if exists provider_documents_storage_delete on storage.objects;
create policy provider_documents_storage_delete on storage.objects
  for delete to authenticated
  using (
    case when bucket_id = 'provider-documents'
          and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.can_admin_org(((storage.foldername(name))[1])::uuid)
      else false
    end
  );

-- No storage UPDATE policy: replacing a file uploads a new object and points
-- the row at it.

commit;
