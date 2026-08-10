-- 20260810a_founder_new_account.sql
--
-- A third founder notification: someone created an operator account.
--
-- Same machinery as 20260731e, deliberately - claim_founder_notification() and
-- dispatch_founder_notification() are unchanged, UNIQUE(organization_id,
-- trigger_key) is still what makes "first" mean first, and internal orgs are
-- still skipped inside the claim. Only the trigger and the key are new.
--
-- WHY org_members AND NOT organizations
--
-- provision_operator_org() inserts the organization first and the owner second,
-- in one transaction. Firing on the organizations insert would send an email
-- about a person whose row does not exist yet, and founder-notify builds
-- "Operator" and "Contact" from the OWNER on org_members - so the email would
-- arrive naming the business and nobody. Firing on the member insert means both
-- facts are committed before pg_net delivers.
--
-- It also matches what was asked for: "when a new person creates an account".
-- The subject is the person, not the row that holds the business name.
--
-- FIRST MEMBER ONLY
--
-- org_members also gains rows when an existing operator invites a teammate.
-- UNIQUE already makes that a no-op for any org that has notified once, but
-- relying on that alone leaves a real hole: an org created BEFORE this migration
-- has no row for this key, so adding a teammate to J2S would fire "new account"
-- about a tenant that has been live since April. Two things close it, and both
-- are here on purpose - the trigger only fires for an org's first member, and
-- section 3 seeds a suppression row for every organization that already exists.

-- ---------------------------------------------------------------------------
-- 1. The new key. The CHECK is an allow-list, so it has to be replaced rather
--    than added to; the claim function would otherwise raise, and it swallows
--    its own exceptions, so the failure would be a silent missing email.
-- ---------------------------------------------------------------------------
alter table public.founder_notifications
  drop constraint if exists founder_notifications_trigger_key_check;

alter table public.founder_notifications
  add constraint founder_notifications_trigger_key_check
  check (trigger_key in ('first_registration', 'first_transaction', 'new_account'));

-- ---------------------------------------------------------------------------
-- 2. The trigger.
--
--    No org_registers_through_enrops() gate here, unlike first_registration:
--    that gate exists because publishing through somebody else's registration
--    system is not an enrops milestone. Signing up IS the milestone regardless
--    of how they later choose to register families.
--
--    Exception-swallowing matches its siblings and is load-bearing: a signup
--    must never fail because a notification could not be queued.
-- ---------------------------------------------------------------------------
create or replace function public.tg_founder_new_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- First member of this organization only. `<> new.id` rather than a plain
  -- count so the row being inserted is not counted against itself.
  if exists (
    select 1 from public.org_members m
     where m.organization_id = new.organization_id
       and m.id <> new.id
  ) then
    return new;
  end if;

  v_id := public.claim_founder_notification(
            new.organization_id, 'new_account', 'org_members', new.id);
  if v_id is not null then
    perform public.dispatch_founder_notification(v_id);
  end if;
  return new;
exception when others then
  return new;
end;
$$;

comment on function public.tg_founder_new_account() is
  'Founder notification: the first member of an organization was created, i.e. somebody signed up. Never blocks the signup.';

drop trigger if exists trg_founder_new_account on public.org_members;
create trigger trg_founder_new_account
  after insert on public.org_members
  for each row execute function public.tg_founder_new_account();

-- ---------------------------------------------------------------------------
-- 3. Suppression backfill - the step that makes "new" honest.
--
--    Every organization that exists right now has already been created, so none
--    of them is news. Without these rows, the first teammate ever invited to an
--    existing org would page the founder about a "new account" that is months
--    old. backfilled = true, sent_at stays null: the row exists to suppress, and
--    the record stays honest about never having been sent.
--
--    Idempotent, and it deliberately covers internal orgs too - one fewer way to
--    ever send about them.
-- ---------------------------------------------------------------------------
insert into public.founder_notifications
  (organization_id, trigger_key, subject_table, subject_id, occurred_at, backfilled)
select o.id, 'new_account', 'organizations', o.id, o.created_at, true
from public.organizations o
on conflict (organization_id, trigger_key) do nothing;
