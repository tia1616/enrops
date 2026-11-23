-- A family's sign-in follows their email when an operator corrects it.
--
-- THE BUG (Jen Israel, 2026-11-23). parents.email was fixed from a typo, but
-- parents.auth_id still pointed at the login made for the typo address. The
-- portal resolves the family by auth_id, so they could only reach their
-- children by signing in at the WRONG address, and signing in at the right one
-- showed an empty portal.
--
-- THE RULE. A linked login must have the same address as the family record
-- (true for all 556 linked parents on prod when this was written, measured, not
-- assumed). When the email changes to something the linked login is NOT, the
-- link is cleared. It is re-made the first time the family signs in at the new
-- address - by claim_parent_record() (portal) or on_auth_user_created_link_parent
-- (a brand-new account) - and signing in requires receiving mail there.
--
-- WHY UNLINK, NEVER RELINK HERE. 20260727b withdrew linking by an email typed
-- into a form, because a typo hands the real owner of the mistyped address a
-- family's portal. An operator correcting an email is exactly such a typed
-- address. So this trigger only ever REMOVES a link.
--
-- ORDERING WITH link_parent_auth_on_email_change. That trigger (20260727a,
-- re-applied to prod 2026-09-03) links by typed email when auth_id is NULL. BEFORE
-- triggers fire in name order and a BEFORE trigger's WHEN sees the NEW row as
-- earlier triggers left it. This one is named zz_ so it runs AFTER it: that
-- trigger sees the old, non-null auth_id and does nothing, then this one clears
-- it. Named a_..., the cleared auth_id would have let that trigger relink to
-- whatever account owns the typed address.
--
-- Pairs with auth-send-magic-link, which now creates the login for a family on
-- file whose corrected address has no account yet (otherwise the parent sign-in
-- page stays silent for that address and they are locked out).

create or replace function public.unlink_parent_signin_on_email_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_login_email text;
begin
  if NEW.auth_id is null then
    return NEW;
  end if;

  select lower(btrim(u.email)) into v_login_email
  from auth.users u
  where u.id = NEW.auth_id;

  -- The login already matches the corrected address (or the login is gone):
  -- keep the link as it is / leave it to the FK behaviour.
  if v_login_email is not null
     and v_login_email <> lower(btrim(coalesce(NEW.email, ''))) then
    NEW.auth_id := null;
  end if;

  return NEW;
end;
$$;

comment on function public.unlink_parent_signin_on_email_change() is
  'BEFORE UPDATE OF email on parents: clears auth_id when the linked login''s email no longer matches the family record. Never links - relinking happens at sign-in (claim_parent_record / on_auth_user_created_link_parent). See 20261123b.';

revoke all on function public.unlink_parent_signin_on_email_change() from public, anon, authenticated;

drop trigger if exists zz_unlink_parent_signin_on_email_change on public.parents;
create trigger zz_unlink_parent_signin_on_email_change
  before update of email on public.parents
  for each row
  when (new.email is distinct from old.email)
  execute function public.unlink_parent_signin_on_email_change();
