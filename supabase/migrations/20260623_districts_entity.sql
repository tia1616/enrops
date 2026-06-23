-- 20260623_districts_entity.sql
--
-- Part of the Schools & Partners redesign (new-provider onboarding).
-- A district is a first-class GROUPING entity — NOT a partner. It owns the
-- academic-calendar source (no-school dates) and district-wide flyer rules +
-- gatekeeper contacts. Schools (venues) link to it via program_locations
-- .district_id. A provider sets up "Portland Public Schools" once and attaches
-- many schools, instead of retyping a code per school.
--
-- BACKWARD COMPATIBLE / ADDITIVE: the legacy free-text program_locations
-- .district and district_calendars.district path is LEFT UNTOUCHED and remains
-- the fallback for derive_program_session_dates(). Nothing reads district_id
-- for date math yet — that change comes in a later, separately-verified step.
-- This migration only introduces the entity + links, so no live tenant
-- (J2S) date math changes.

create table if not exists districts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  -- Maps to the legacy district_calendars.district code (e.g. 'Portland') so a
  -- formalized district can find its already-uploaded calendar without re-upload.
  calendar_key text,
  flyer_distribution text check (
    flyer_distribution in ('direct','approval_required','peachjar','declined','unknown')
  ),
  flyer_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS + grants: mirror the `partners` table exactly (single org-scoped policy).
alter table districts enable row level security;
drop policy if exists org_access_districts on districts;
create policy org_access_districts on districts for all using (check_org_access(organization_id));
grant select, insert, update, delete, references, trigger, truncate on districts to anon, authenticated, service_role;

create index if not exists idx_districts_org on districts(organization_id);

-- Repoint program_locations.district_id from partners -> districts. It was added
-- in 20260623_program_locations_district_link pointing at partners as an interim;
-- districts are now their own entity (per "districts are not partners"). The
-- column is unpopulated in every environment, so this is safe.
alter table program_locations drop constraint if exists program_locations_district_id_fkey;
alter table program_locations
  add constraint program_locations_district_id_fkey
  foreign key (district_id) references districts(id) on delete set null;

-- Same-org trigger: district_id now validates against districts, not partners.
create or replace function program_locations_partner_same_org()
returns trigger
language plpgsql
as $$
declare
  partner_org uuid;
  district_org uuid;
begin
  if new.partner_id is not null then
    select organization_id into partner_org from partners where id = new.partner_id;
    if partner_org is null then
      raise exception 'partner % not found', new.partner_id;
    end if;
    if partner_org <> new.organization_id then
      raise exception 'partner % belongs to a different organisation', new.partner_id;
    end if;
  end if;

  if new.district_id is not null then
    select organization_id into district_org from districts where id = new.district_id;
    if district_org is null then
      raise exception 'district % not found', new.district_id;
    end if;
    if district_org <> new.organization_id then
      raise exception 'district % belongs to a different organisation', new.district_id;
    end if;
  end if;

  return new;
end;
$$;

-- Link the academic calendars to the district entity (nullable; the legacy
-- free-text district code is retained as the fallback key).
alter table district_calendars
  add column if not exists district_id uuid references districts(id) on delete set null;
create index if not exists idx_district_calendars_district_id on district_calendars(district_id);

comment on table districts is
  'A school district as a first-class grouping entity (NOT a partner). Owns academic-calendar source + district-wide flyer rules. Schools link via program_locations.district_id. Additive/backward-compatible with the legacy free-text district path.';
