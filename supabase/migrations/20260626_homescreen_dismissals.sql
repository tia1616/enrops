-- Per-admin dismissals for the home "Important today" heads-up signals.
-- Org-scoped for tenant isolation; per-user so one admin's "Not now" doesn't
-- hide a real action from another. signal_key = the card type (aggregate, not
-- per-item). dismissed_until = a 24h snooze; permanent = "dismiss completely".
-- Idempotent: safe to re-run (applied to staging via MCP 2026-06-26).
create table if not exists public.homescreen_dismissals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  signal_key text not null,
  dismissed_until timestamptz,
  permanent boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id, signal_key)
);

alter table public.homescreen_dismissals enable row level security;

-- A member can only see/modify their OWN dismissals within an org they belong to.
drop policy if exists hd_own_all on public.homescreen_dismissals;
create policy hd_own_all on public.homescreen_dismissals
  for all
  using (public.is_org_member(organization_id) and user_id = auth.uid())
  with check (public.is_org_member(organization_id) and user_id = auth.uid());

-- Authenticated callers only; RLS does the row scoping. No anon/public access.
revoke all on public.homescreen_dismissals from anon, public;
grant select, insert, update, delete on public.homescreen_dismissals to authenticated;
