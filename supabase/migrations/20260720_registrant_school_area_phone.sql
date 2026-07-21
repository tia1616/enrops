-- Registrant -> marketing list: resolve school, area, and phone correctly.
--
-- THE BUG THIS FIXES
-- ------------------
-- auto_add_registrant_to_marketing_list() resolved the contact's school through
-- students.program_location_id. That column is NULL on every student row (342/342
-- on prod), because create-registration inserts a key named `school_id` -- a
-- column that does not exist on students. The frontend never sends that key, so
-- it arrives undefined, JSON.stringify drops it, the insert succeeds, and the
-- school is silently never recorded.
--
-- Result: 252 of 255 contacts created by registration had school_name = NULL.
-- Campaign sends segment by school, so every family who registered through
-- Enrops was invisible to a school-targeted send.
--
-- THE FIX
-- -------
-- Resolve the location from the thing the family actually registered for. A
-- registration always carries either program_id (afterschool) or camp_session_id
-- (camp), and each of those carries the location. That path is authoritative and
-- needs no client input. students.program_location_id is kept only as a last
-- resort, so this still works if some other path ever populates it.
--
-- Also now captured, both previously dropped on the floor:
--   * geo_segment  <- program_locations.area (populated 62/62 on prod: Portland,
--                     Hillsboro, Camas, Lake Oswego, ...). This is why contacts
--                     need no parent-entered city: the area comes from the school
--                     the child attends.
--   * phone        <- parents.phone (was never copied; 255/255 rows had no phone).
--
-- Tenant scoping: this is SECURITY DEFINER, so RLS does not apply. Every lookup
-- is constrained to NEW.organization_id. `parents` has no organization_id column,
-- so it is reached only through the registration's own parent_id FK.
--
-- Behavior preserved: still fires only on a transition into 'confirmed', still
-- gated on organizations.auto_subscribe_registrants, still ON CONFLICT DO NOTHING
-- (enriching pre-existing rows is a separate, reviewable backfill -- this trigger
-- never overwrites a contact the operator may have edited by hand).

create or replace function public.auto_add_registrant_to_marketing_list()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_auto_enabled  boolean;
  v_parent_email  text;
  v_parent_name   text;
  v_parent_phone  text;
  v_child_first   text;
  v_child_last    text;
  v_school_name   text;
  v_area          text;
begin
  if (TG_OP = 'UPDATE') then
    if NEW.status is not distinct from OLD.status then return NEW; end if;
  end if;
  if NEW.status is null or NEW.status <> 'confirmed' then return NEW; end if;

  select auto_subscribe_registrants into v_auto_enabled
  from organizations where id = NEW.organization_id;
  if v_auto_enabled is not true then return NEW; end if;

  -- parents has no organization_id; the registration's FK is the scope.
  select p.email,
         nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
         nullif(trim(coalesce(p.phone, '')), '')
    into v_parent_email, v_parent_name, v_parent_phone
  from parents p where p.id = NEW.parent_id;
  if v_parent_email is null then return NEW; end if;

  select s.first_name, s.last_name
    into v_child_first, v_child_last
  from students s
  where s.id = NEW.student_id
    and s.organization_id = NEW.organization_id;

  -- Primary: afterschool program -> its location.
  if NEW.program_id is not null then
    select pl.name, nullif(trim(coalesce(pl.area, '')), '')
      into v_school_name, v_area
    from programs pr
    join program_locations pl
      on pl.id = pr.program_location_id
     and pl.organization_id = NEW.organization_id
    where pr.id = NEW.program_id
      and pr.organization_id = NEW.organization_id;

  -- Primary: camp session -> its location. camp_sessions.location_id may be null
  -- on older rows, which still carry a free-text location_name; prefer the linked
  -- location (it is the one that has an area) and fall back to the text.
  elsif NEW.camp_session_id is not null then
    select coalesce(pl.name, cs.location_name), nullif(trim(coalesce(pl.area, '')), '')
      into v_school_name, v_area
    from camp_sessions cs
    left join program_locations pl
      on pl.id = cs.location_id
     and pl.organization_id = NEW.organization_id
    where cs.id = NEW.camp_session_id
      and cs.organization_id = NEW.organization_id;
  end if;

  -- Last resort only. NULL on every prod row today; harmless if that changes.
  if v_school_name is null then
    select pl.name, nullif(trim(coalesce(pl.area, '')), '')
      into v_school_name, v_area
    from students s
    join program_locations pl
      on pl.id = s.program_location_id
     and pl.organization_id = NEW.organization_id
    where s.id = NEW.student_id
      and s.organization_id = NEW.organization_id;
  end if;

  insert into marketing_recipients (
    organization_id, email, parent_name, phone, child_first_name, child_last_name,
    school_name, geo_segment, source, segments
  )
  values (
    NEW.organization_id,
    lower(v_parent_email),
    v_parent_name,
    v_parent_phone,
    v_child_first,
    v_child_last,
    v_school_name,
    v_area,
    'enrops_registration',
    array['registrant']::text[]
  )
  on conflict do nothing;

  return NEW;
end;
$function$;
