-- Auto-default program_locations.area from the address city when left blank, on
-- every write path (manual Location form, bulk partner import, future sync) so
-- every tenant's locations get an area without a manual backfill. Operator-set
-- area always wins; the trigger only fills when area is null/empty.
--
-- US address format ".., City, ST ZIP" -> "City". NOTE: PostgreSQL regex uses \y
-- for word boundaries (NOT \b — in PG \b is a backspace char; using \b silently
-- matches nothing). search_path pinned per the security advisor.
create or replace function public.default_location_area()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.area is null or btrim(new.area) = '') and new.address is not null then
    new.area := nullif(btrim((regexp_match(new.address, ',\s*([^,]+),\s*[A-Za-z]{2}\y'))[1]), '');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_default_location_area on public.program_locations;
create trigger trg_default_location_area
  before insert or update on public.program_locations
  for each row execute function public.default_location_area();
