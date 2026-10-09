-- Correcting a family's email on the roster now corrects their Contacts entry too.
--
-- The roster edit writes parents.email. The Contacts list (marketing_recipients)
-- is a separate copy made at registration, keyed (organization_id, email), and
-- nothing carried an email change across: the family looked fixed on the roster
-- while every marketing send still went to the old, usually mistyped, address.
-- Same shape as trg_sync_student_name_to_contact, which carries a name change.
--
-- Scope: only this parent's own contact rows, in orgs this parent belongs to
-- (parent_org_relationships). If the corrected address already has a Contacts
-- row in that org the old row is left alone: (organization_id, email) is unique,
-- the family is already reachable at the right address, and marketing_sends
-- rows may reference the old one.

create or replace function public.sync_parent_email_to_contact()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_old text := lower(btrim(coalesce(OLD.email, '')));
  v_new text := lower(btrim(coalesce(NEW.email, '')));
begin
  if v_new = '' or v_old = '' or v_old = v_new then
    return NEW;
  end if;

  update marketing_recipients mr
     set email      = btrim(NEW.email),
         updated_at = now()
   where lower(mr.email) = v_old
     and mr.organization_id in (
           select r.organization_id from parent_org_relationships r where r.parent_id = NEW.id
         )
     and not exists (
           select 1 from marketing_recipients x
            where x.organization_id = mr.organization_id
              and lower(x.email) = v_new
         );

  return NEW;
end;
$function$;

-- A trigger function needs no EXECUTE for the invoking role; keep it off the API.
revoke execute on function public.sync_parent_email_to_contact() from public, anon, authenticated;

drop trigger if exists trg_sync_parent_email_to_contact on public.parents;
create trigger trg_sync_parent_email_to_contact
  after update of email on public.parents
  for each row
  when (old.email is distinct from new.email)
  execute function public.sync_parent_email_to_contact();
