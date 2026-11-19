-- save_site: ONE write path for adding a site, used by every "add a location"
-- form (AddSchoolModal, LocationsList, the quick program builder).
--
-- Why a function: adding a school writes up to three rows (a district, a school
-- partner, the site). Done from the browser as separate inserts, a failure on the
-- site left an orphan partner behind (AddSchoolModal's own comment said so), and
-- the three forms each had their own copy of the district match-before-create.
-- Here it is one transaction: all three rows land or none do.
--
-- SECURITY INVOKER on purpose: the caller's own RLS decides. program_locations
-- needs can_edit_org (owner/admin/staff); a viewer's call fails on the site
-- insert and the district/partner rows it wrote roll back with it.
--
-- Partner rules (Jessica 2026-11-19: "create partner, no contacts"):
--   p_partner_id set           -> link to that existing partner (umbrella pick).
--   p_at_partner, no id        -> create the school partner, name only.
--     partners has UNIQUE (organization_id, partner_name). A same-name partner
--     with NO site yet (contact-only, e.g. from an import) is reused - it is this
--     school. One that already has a site is a different place with the same
--     name, so we refuse with a readable message instead of merging silently.
--   p_partner_is_umbrella      -> a same-name umbrella is always reused (an
--     umbrella has many sites by definition).
--   not at a partner           -> no partner row (a studio, the provider's own space).
--
-- District: the caller decides whether the choice was deliberate (the forms
-- refuse an untouched picker). Here: an id is used as given; a new name is
-- matched case-insensitively first (districts_org_name_lower_uniq), else created.
-- Writes district_id only, exactly as every existing editor does.

create or replace function public.save_site(
  p_organization_id     uuid,
  p_name                text,
  p_address             text    default null,
  p_area                text    default null,
  p_at_partner          boolean default false,
  p_partner_id          uuid    default null,
  p_partner_name        text    default null,
  p_partner_type        text    default null,
  p_partner_is_umbrella boolean default false,
  p_district_id         uuid    default null,
  p_new_district_name   text    default null
)
returns public.program_locations
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_name        text := nullif(btrim(coalesce(p_name, '')), '');
  v_address     text := nullif(btrim(coalesce(p_address, '')), '');
  v_area        text := nullif(btrim(coalesce(p_area, '')), '');
  v_district_id uuid := p_district_id;
  v_new_dist    text := nullif(btrim(coalesce(p_new_district_name, '')), '');
  v_partner_id  uuid := p_partner_id;
  v_pname       text;
  v_existing    uuid;
  v_has_site    boolean;
  v_slug        text;
  v_row         public.program_locations;
begin
  if p_organization_id is null then
    raise exception 'save_site: organization is required';
  end if;
  if v_name is null then
    raise exception 'Location name is required.';
  end if;

  -- Area: same rule as trg_default_location_area, computed here only so the new
  -- partner row gets the same location_area AddSchoolModal used to give it.
  if v_area is null and v_address is not null then
    v_area := nullif(btrim((regexp_match(v_address, ',\s*([^,]+),\s*[A-Za-z]{2}\y'))[1]), '');
  end if;

  -- 1) District
  if v_new_dist is not null then
    select d.id into v_district_id
      from districts d
     where d.organization_id = p_organization_id
       and lower(btrim(d.name)) = lower(v_new_dist)
     limit 1;
    if v_district_id is null then
      insert into districts (organization_id, name)
      values (p_organization_id, v_new_dist)
      returning id into v_district_id;
    end if;
  end if;

  -- 2) Partner
  if v_partner_id is null and coalesce(p_at_partner, false) then
    v_pname := coalesce(nullif(btrim(coalesce(p_partner_name, '')), ''), v_name);
    select p.id into v_existing
      from partners p
     where p.organization_id = p_organization_id
       and p.partner_name = v_pname;
    if v_existing is not null then
      select exists (select 1 from program_locations l where l.partner_id = v_existing)
        into v_has_site;
      if coalesce(p_partner_is_umbrella, false) or not v_has_site then
        v_partner_id := v_existing;
      else
        raise exception 'You already have a site linked to a school partner called "%". If this is a second site for the same organization, tick "belongs to a bigger organization" and pick it. Otherwise give this one a different name.', v_pname;
      end if;
    else
      insert into partners (organization_id, partner_name, partner_type, location_area)
      values (
        p_organization_id,
        v_pname,
        nullif(btrim(coalesce(p_partner_type, '')), ''),
        case when coalesce(p_partner_is_umbrella, false) then null else v_area end
      )
      returning id into v_partner_id;
    end if;
  end if;

  -- 3) Site. slug is NOT NULL + globally unique: name-slug + random suffix, the
  -- same shape the three forms generated client-side.
  v_slug := coalesce(
              nullif(left(btrim(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), '-'), 40), ''),
              'venue'
            ) || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 6);

  insert into program_locations (organization_id, name, address, area, district_id, partner_id, slug)
  values (p_organization_id, v_name, v_address, v_area, v_district_id, v_partner_id, v_slug)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.save_site(uuid, text, text, text, boolean, uuid, text, text, boolean, uuid, text) from public;
revoke all on function public.save_site(uuid, text, text, text, boolean, uuid, text, text, boolean, uuid, text) from anon;
grant execute on function public.save_site(uuid, text, text, text, boolean, uuid, text, text, boolean, uuid, text) to authenticated;
