-- A per-org "saved tags" registry so an operator can create a tag once (VIP,
-- Lead, Alumni…) and reuse it everywhere they pick tags — the Contacts filter,
-- the contact edit screen, import — even before any contact has it. Contacts
-- still store tags on marketing_recipients.tags[]; this is just the pick-list.
-- Additive. Applied to staging via MCP 2026-07-05; prod at release.
create table if not exists public.marketing_tags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);

alter table public.marketing_tags enable row level security;

-- Org-scoped, mirrors marketing_recipients: a member can read/add their org's
-- tags; with_check blocks inserting under another org.
drop policy if exists org_manage_marketing_tags on public.marketing_tags;
create policy org_manage_marketing_tags on public.marketing_tags
  for all
  using (check_org_access(organization_id))
  with check (check_org_access(organization_id));

grant select, insert, delete on public.marketing_tags to authenticated;
