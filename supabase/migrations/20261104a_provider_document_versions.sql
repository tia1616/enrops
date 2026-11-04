-- Keep every replaced certificate (Jessica 2026-11-04: "copy however other
-- platforms archive"). Compliance tools (TrustLayer, myCOI) keep a document's
-- history: each earlier upload stays on file, marked replaced with its dates,
-- and the host can still open it, so "what was in force on Oct 15?" has an
-- answer and a recorded decision still points at what the host reviewed.
--
-- Until now, "Upload a new version" repointed the row and deleted the old file.
--
-- HOW. A BEFORE UPDATE trigger on provider_documents: whenever storage_path
-- changes, the old file's path and the dates it carried are copied into
-- provider_document_versions first. A trigger, not app code, so no screen,
-- script or future caller can replace a file without keeping the old one. The
-- app stops deleting the old file.
--
-- WHO SEES THEM. Exactly who sees the document: the select policy is "the
-- parent document is readable by you", so RLS on provider_documents decides
-- (the provider's members; a partner for documents shown to it). Storage reads
-- follow the same rule. No client writes: only the trigger inserts. Removing a
-- document removes its history too (cascade), and the app removes those files.
--
-- Grants explicit (Supabase 2026-10-30 change).

create table if not exists public.provider_document_versions (
  id                 uuid primary key default gen_random_uuid(),
  document_id        uuid not null references public.provider_documents(id) on delete cascade,
  organization_id    uuid not null,
  storage_path       text not null unique,
  original_filename  text,
  received_on        date,
  effective_on       date,
  expires_on         date,
  replaced_at        timestamptz not null default now(),
  replaced_by        uuid
);
create index if not exists provider_document_versions_doc on public.provider_document_versions (document_id, replaced_at desc);

alter table public.provider_document_versions enable row level security;
revoke all on public.provider_document_versions from public, anon, authenticated;
grant select on public.provider_document_versions to authenticated;
grant all on public.provider_document_versions to service_role;

drop policy if exists provider_document_versions_select on public.provider_document_versions;
create policy provider_document_versions_select on public.provider_document_versions
  for select to authenticated
  using (exists (select 1 from public.provider_documents d where d.id = provider_document_versions.document_id));

comment on table public.provider_document_versions is
  'Earlier files of a provider document, kept when a new version is uploaded. Written only by the archive_replaced_document_file trigger; readable by whoever can read the document.';

create or replace function private.archive_replaced_document_file()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.storage_path is distinct from old.storage_path and old.storage_path is not null then
    insert into public.provider_document_versions (
      document_id, organization_id, storage_path, original_filename,
      received_on, effective_on, expires_on, replaced_by
    ) values (
      old.id, old.organization_id, old.storage_path, old.original_filename,
      old.received_on, old.effective_on, old.expires_on, auth.uid()
    )
    on conflict (storage_path) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function private.archive_replaced_document_file() from public, anon, authenticated;

drop trigger if exists archive_replaced_document_file on public.provider_documents;
create trigger archive_replaced_document_file
  before update of storage_path on public.provider_documents
  for each row execute function private.archive_replaced_document_file();

-- Storage: an earlier version opens for whoever can read its document. The
-- current-file and owner/admin rules are unchanged.
drop policy if exists provider_documents_storage_select on storage.objects;
create policy provider_documents_storage_select on storage.objects
  for select to authenticated
  using (
    case when bucket_id = 'provider-documents' then
      exists (select 1 from public.provider_documents d where d.storage_path = name)
      or exists (select 1 from public.provider_document_versions v where v.storage_path = name)
      or case when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           then public.can_admin_org(((storage.foldername(name))[1])::uuid)
           else false
         end
    else false
    end
  );
