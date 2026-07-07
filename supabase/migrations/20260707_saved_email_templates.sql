-- Org-scoped reusable email templates (Richelle's ask). Operators save an email's
-- subject+body once and reuse it (win-back, welcomes, anything repeated). Body is
-- the same friendly-editor HTML as campaign touchpoints, so merge tokens survive.
create table if not exists public.saved_email_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  subject text,
  body_html text,
  body_text text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists saved_email_templates_org_idx
  on public.saved_email_templates (organization_id, updated_at desc);

alter table public.saved_email_templates enable row level security;

-- Org owners/admins manage their org's templates. Uses the SAME canonical
-- helpers as the org_branding write gate (single source of truth for "who can
-- admin this org"): can_admin_org() = owner/admin with an ACCEPTED membership,
-- and is_platform_admin() lets J2S support a tenant. A raw org_members subquery
-- was rejected in review — it silently omitted the accepted_at check (pending
-- invites would leak in) and the platform-admin path.
create policy saved_email_templates_org_admin_all on public.saved_email_templates
  for all to authenticated
  using (can_admin_org(organization_id) or is_platform_admin())
  with check (can_admin_org(organization_id) or is_platform_admin());

grant select, insert, update, delete on public.saved_email_templates to authenticated;
