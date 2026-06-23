-- 20260623_districts_hardening.sql
--
-- Hardening found during the Schools & Partners audit. Runs AFTER
-- 20260623_districts_entity.sql. All redesign-scoped:
--
-- 1. districts: no uniqueness on name → the District picker could create two
--    "Portland Public Schools" entities, which would confuse the picker and the
--    upcoming rename/management UI. Add a case-insensitive unique per org.
-- 2. district_calendars.district_id had no same-org guard (its sibling
--    program_locations.district_id does). Add a matching trigger so a calendar
--    can't be linked to another org's district even via a crafted API call.
-- 3. program_locations_partner_same_org() was created without SET search_path
--    (flagged by the Supabase security advisor: function_search_path_mutable).
--    Re-create it identically but with a pinned search_path.

-- 1. Case-insensitive unique district name per org.
create unique index if not exists districts_org_name_lower_uniq
  on districts (organization_id, lower(name));

-- 2. Same-org guard for district_calendars.district_id.
create or replace function district_calendars_district_same_org()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  d_org uuid;
begin
  if new.district_id is not null then
    select organization_id into d_org from districts where id = new.district_id;
    if d_org is null then
      raise exception 'district % not found', new.district_id;
    end if;
    if d_org <> new.organization_id then
      raise exception 'district % belongs to a different organisation', new.district_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_district_calendars_district_same_org on district_calendars;
create trigger trg_district_calendars_district_same_org
  before insert or update on district_calendars
  for each row execute function district_calendars_district_same_org();

-- 3. Pin search_path on the existing same-org trigger fn (advisor WARN).
create or replace function program_locations_partner_same_org()
returns trigger
language plpgsql
set search_path = public, pg_temp
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
