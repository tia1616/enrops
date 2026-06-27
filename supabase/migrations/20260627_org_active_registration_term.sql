-- Single source of truth for the term the public catalog serves, per org.
-- Replaces a hardcoded 'FA26' that previously lived in BOTH the frontend
-- (Home.jsx catalog load + Share gate) AND the marketing-touchpoint-send edge
-- function — two copies that could silently drift. Now every reader pulls this
-- one per-org DB value (the frontend via the public_org_directory view).
alter table public.organizations
  add column if not exists active_registration_term text not null default 'FA26';

-- Expose it on the safe public view so the public catalog (anon) can read it.
-- Adds only a non-sensitive term code; preserves existing columns + grants.
create or replace view public.public_org_directory as
  select id, slug, name, logo_url, logo_email_url, status, timezone, active_registration_term
  from public.organizations
  where status = 'active';
