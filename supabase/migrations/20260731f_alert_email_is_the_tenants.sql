-- 20260728d_alert_email_is_the_tenants.sql
--
-- THE GAP: organizations.alert_email is the address a PROVIDER's own operational
-- alerts go to (a contractor declined, a background check came back, a sub offer
-- was answered, someone asked to resume onboarding). On prod, 10 of 12 providers
-- had no value at all, because nothing in self-serve signup ever set one and there
-- is no UI field for it.
--
-- Two separate consequences, both bad:
--   1. loadOrgBrand() cascades a missing alert_email to the ENROPS row, so a
--      provider's own alerts were addressed to hello@enrops.com. Their mail,
--      our inbox.
--   2. Several alert paths read the column directly and simply RETURN when it is
--      null, so those alerts were never sent to anyone at all.
--
-- THE RULE (Jessica, 2026-07-28): an alert address is always the TENANT's own
-- email. Never the platform's.
--
-- Fixed in two parts so it cannot regress:
--   A. Backfill every existing provider from their own owner/contact address.
--   B. Triggers so a newly created provider is never born without one. Triggers
--      rather than app code because signup, hand-provisioning and any future SQL
--      all have to satisfy this, and only the database sees every one of them.
--
-- Note on ordering: an organization row is created BEFORE its owner exists in
-- org_members, so neither trigger alone is enough. The org trigger uses the
-- contact email present at creation; the member trigger fills the gap afterwards
-- for any org created without one.

-- ---------------------------------------------------------------------------
-- A. Backfill.
--    Owner's personal address is preferred over the org's public contact address:
--    an alert needs a human to read it. On prod this is the difference between
--    reaching richelle@mrsrichelle.com and reaching info@mrsrichelle.com.
-- ---------------------------------------------------------------------------
update public.organizations o
   set alert_email = coalesce(
         (select m.email
            from public.org_members m
           where m.organization_id = o.id
             and m.role = 'owner'
             and m.email is not null
           order by m.created_at
           limit 1),
         o.email
       )
 where o.alert_email is null
   and coalesce(
         (select m.email from public.org_members m
           where m.organization_id = o.id and m.role = 'owner' and m.email is not null
           order by m.created_at limit 1),
         o.email
       ) is not null;

-- ---------------------------------------------------------------------------
-- B1. A new organization inherits its contact email as the alert address.
--     INSERT only, deliberately: firing on UPDATE would silently undo a future
--     deliberate clearing of the field.
-- ---------------------------------------------------------------------------
create or replace function public.tg_org_default_alert_email()
returns trigger
language plpgsql
as $$
begin
  if new.alert_email is null then
    new.alert_email := new.email;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_org_default_alert_email on public.organizations;
create trigger trg_org_default_alert_email
  before insert on public.organizations
  for each row execute function public.tg_org_default_alert_email();

-- ---------------------------------------------------------------------------
-- B2. When the owner is attached, use their address if the org still has none.
--     This is the path that actually catches self-serve signup, where the org row
--     is written before the member row.
-- ---------------------------------------------------------------------------
create or replace function public.tg_owner_sets_alert_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role = 'owner' and new.email is not null then
    update public.organizations
       set alert_email = new.email
     where id = new.organization_id
       and alert_email is null;
  end if;
  return new;
exception when others then
  -- Never let this cost someone their team membership.
  return new;
end;
$$;

drop trigger if exists trg_owner_sets_alert_email on public.org_members;
create trigger trg_owner_sets_alert_email
  after insert on public.org_members
  for each row execute function public.tg_owner_sets_alert_email();

comment on column public.organizations.alert_email is
  'Where THIS provider''s own operational alerts go. Always the tenant''s own address, never the platform''s. Auto-populated at creation and when the owner is attached; see 20260728d.';
