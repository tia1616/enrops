-- make_site_a_partner: turn an existing partner-less site into a school-partner
-- site, in ONE transaction. The edit-side twin of save_site (20261119b), used by
-- the site drawer's "This is at a school" button on the one Locations list.
--
-- Same partner rules as save_site, so the two can't disagree:
--   - the partner is named after the site;
--   - a same-name partner with no LIVE site (contact-only, an import, or one whose
--     only site was archived) is reused, and a missing partner_type is filled;
--   - a same-name partner that already has a live site is a different place:
--     refuse with a readable message;
--   - a site that already has a partner is returned unchanged (idempotent).
--
-- SECURITY INVOKER: the caller's RLS decides (program_locations writes need
-- can_edit_org). A viewer's call fails on the location update and the partner
-- insert rolls back with it.

create or replace function public.make_site_a_partner(
  p_location_id  uuid,
  p_partner_type text default null
)
returns public.program_locations
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_loc       public.program_locations;
  v_type      text := nullif(btrim(coalesce(p_partner_type, '')), '');
  v_existing  uuid;
  v_has_site  boolean;
  v_partner   uuid;
begin
  select * into v_loc from program_locations where id = p_location_id;
  if v_loc.id is null then
    raise exception 'That location was not found.';
  end if;
  if v_loc.partner_id is not null then
    return v_loc;
  end if;

  select p.id into v_existing
    from partners p
   where p.organization_id = v_loc.organization_id
     and p.partner_name = v_loc.name;

  if v_existing is not null then
    select exists (
      select 1 from program_locations l
       where l.partner_id = v_existing
         and coalesce(l.archived, false) = false
         and l.id <> v_loc.id
    ) into v_has_site;
    if v_has_site then
      raise exception 'You already have a site for a school partner called "%". Rename this site first, for example add the campus or street.', v_loc.name;
    end if;
    v_partner := v_existing;
    update partners set partner_type = v_type
     where id = v_existing and partner_type is null and v_type is not null;
  else
    begin
      insert into partners (organization_id, partner_name, partner_type, location_area)
      values (v_loc.organization_id, v_loc.name, v_type, v_loc.area)
      returning id into v_partner;
    exception when unique_violation then
      raise exception 'A school partner called "%" was just added by someone else. Try again.', v_loc.name;
    end;
  end if;

  update program_locations set partner_id = v_partner
   where id = v_loc.id
  returning * into v_loc;

  if v_loc.id is null then
    raise exception 'You don''t have permission to change this location.';
  end if;
  return v_loc;
end;
$$;

revoke all on function public.make_site_a_partner(uuid, text) from public;
revoke all on function public.make_site_a_partner(uuid, text) from anon;
grant execute on function public.make_site_a_partner(uuid, text) to authenticated;
