-- Keep the family's Family Comms contact (marketing_recipients) in sync when an
-- operator corrects a student's name on the roster.
--
-- Why: at registration, parents sometimes type their OWN name in the student
-- name field. When an operator fixes it on the roster (students.first_name /
-- last_name), the denormalized child name on marketing_recipients
-- (child_first_name / child_last_name) would otherwise stay stale and show the
-- wrong name in marketing/comms emails. There is no FK from a student to its
-- contact row -- the only join is (organization_id, parent email) -- so this
-- trigger matches on the PARENT'S EMAIL plus the OLD child name. Matching the
-- old name means:
--   * a sibling's contact row (different child name, same parent email) is
--     never clobbered by renaming this student, and
--   * an unrelated family is never touched.
-- Conservative by design: if the contact's child name doesn't already match
-- this student's old name (e.g. it was hand-entered with a different spelling),
-- nothing is synced -- the one-time backfill / manual edit handles those.
--
-- SECURITY DEFINER so the write reaches marketing_recipients regardless of the
-- caller's grants; the match is still hard-scoped to NEW.organization_id, so it
-- cannot cross tenants. Mirrors auto_add_registrant_to_marketing_list().

create or replace function sync_student_name_to_contact()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  -- Only act when the name actually changed.
  if NEW.first_name is not distinct from OLD.first_name
     and NEW.last_name is not distinct from OLD.last_name then
    return NEW;
  end if;

  -- No org or no parent -> nothing to match a contact on.
  if NEW.organization_id is null or NEW.parent_id is null then
    return NEW;
  end if;

  select lower(email) into v_email from parents where id = NEW.parent_id;
  if v_email is null or v_email = '' then
    return NEW;
  end if;

  update marketing_recipients mr
     set child_first_name = NEW.first_name,
         child_last_name  = NEW.last_name,
         updated_at       = now()
   where mr.organization_id = NEW.organization_id
     and lower(mr.email) = v_email
     and lower(btrim(coalesce(mr.child_first_name, ''))) = lower(btrim(coalesce(OLD.first_name, '')))
     and lower(btrim(coalesce(mr.child_last_name, '')))  = lower(btrim(coalesce(OLD.last_name, '')));

  return NEW;
end;
$$;

comment on function sync_student_name_to_contact() is
  'On a student first/last name change, updates the matching Family Comms contact (marketing_recipients child name), matched by organization_id + parent email + the OLD child name so siblings and unrelated families are never clobbered. SECURITY DEFINER; tenant-scoped to NEW.organization_id.';

drop trigger if exists trg_sync_student_name_to_contact on students;
create trigger trg_sync_student_name_to_contact
  after update of first_name, last_name on students
  for each row
  execute function sync_student_name_to_contact();
