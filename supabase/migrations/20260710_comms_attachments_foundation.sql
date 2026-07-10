-- Comms attachments: reusable per-org file library + which files each email carries.
-- Additive and empty. Mirrors existing idioms:
--   table RLS  -> can_admin_org(org) OR is_platform_admin()  (like saved_email_templates)
--   storage    -> {org.id}/ folder gated to org owner/admin   (like org-assets)
-- Applied to staging 2026-07-10 via MCP. Apply to prod in the same feature pass (parity), on Jessica's go.

-- 1. File library table
create table if not exists public.comms_attachments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  file_name       text not null,
  storage_path    text not null,            -- object path within the comms-attachments bucket: {org.id}/attachments/...
  byte_size       bigint not null,
  content_type    text not null,
  title           text,                     -- optional operator-facing label
  uploaded_by     uuid,                     -- auth.users id (nullable; set client-side)
  created_at      timestamptz not null default now(),
  archived_at     timestamptz               -- soft-archive so history stays intact
);

create index if not exists comms_attachments_org_active_idx
  on public.comms_attachments(organization_id)
  where archived_at is null;

alter table public.comms_attachments enable row level security;

drop policy if exists comms_attachments_org_admin_all on public.comms_attachments;
create policy comms_attachments_org_admin_all
  on public.comms_attachments
  for all
  to authenticated
  using (can_admin_org(organization_id) or is_platform_admin())
  with check (can_admin_org(organization_id) or is_platform_admin());

grant select, insert, update, delete on public.comms_attachments to authenticated;

-- 2. Which files a given email carries (dedicated, queryable; additive/empty).
alter table public.automations
  add column if not exists attachment_ids uuid[] not null default '{}';
alter table public.saved_email_templates
  add column if not exists attachment_ids uuid[] not null default '{}';
alter table public.marketing_campaign_touchpoints
  add column if not exists attachment_ids uuid[] not null default '{}';

-- 3. Public bucket for hosted "Download" links (shared marketing files; no PII).
insert into storage.buckets (id, name, public)
values ('comms-attachments', 'comms-attachments', true)
on conflict (id) do nothing;

-- 4. Storage object policies mirroring org-assets (write gated by {org.id}/ folder to owner/admin;
--    public read is implicit for a public bucket).
drop policy if exists comms_attachments_org_admin_insert on storage.objects;
create policy comms_attachments_org_admin_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'comms-attachments'
    and ((storage.foldername(name))[1])::uuid in (
      select organization_id from org_members
      where auth_user_id = auth.uid() and role = any (array['owner','admin'])
    )
  );

drop policy if exists comms_attachments_org_admin_update on storage.objects;
create policy comms_attachments_org_admin_update
  on storage.objects for update to authenticated
  using (
    bucket_id = 'comms-attachments'
    and ((storage.foldername(name))[1])::uuid in (
      select organization_id from org_members
      where auth_user_id = auth.uid() and role = any (array['owner','admin'])
    )
  );

drop policy if exists comms_attachments_org_admin_delete on storage.objects;
create policy comms_attachments_org_admin_delete
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'comms-attachments'
    and ((storage.foldername(name))[1])::uuid in (
      select organization_id from org_members
      where auth_user_id = auth.uid() and role = any (array['owner','admin'])
    )
  );

drop policy if exists comms_attachments_platform_admin_write on storage.objects;
create policy comms_attachments_platform_admin_write
  on storage.objects for all to authenticated
  using (bucket_id = 'comms-attachments' and is_platform_admin())
  with check (bucket_id = 'comms-attachments' and is_platform_admin());
