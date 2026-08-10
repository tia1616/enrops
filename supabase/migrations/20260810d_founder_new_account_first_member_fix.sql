-- 20260810d_founder_new_account_first_member_fix.sql
--
-- (20260810c is the Stripe publish gate from another branch. This is d.)
--
-- Code-review finding on 20260810a: a multi-row insert of an organization's
-- first members notifies NOBODY.
--
-- The guard asked "does any OTHER member row exist for this org", which reads
-- like "am I the first". It is not the same question. AFTER ... FOR EACH ROW
-- triggers are queued and fired once the whole statement has completed, so on
--
--   insert into org_members values (owner), (admin);
--
-- both triggers run with BOTH rows already visible. Each one finds the other,
-- concludes it is not first, and returns. No claim, no dispatch, no email - and
-- no trace either: no row, no send_error, nothing to notice. Silent nothing is
-- the worst possible failure for the one feature whose job is to not miss a
-- signup.
--
-- Reproduced on staging before writing this fix: an org with an owner and an
-- admin inserted in one statement produced 0 rows in founder_notifications.
--
-- provision_operator_org() inserts a single member, so the live self-serve
-- signup path was never affected. supabase/schema/staging_seed.sql and
-- staging_people_seed.sql already use the multi-row form, and any future
-- "invite your team while you sign up" would too.
--
-- THE FIX: ask whether this row is the EARLIEST member rather than the ONLY
-- one. In a multi-row insert every row shares the statement's now(), so the
-- tiebreak falls to id and exactly one row has no predecessor - exactly one
-- claim, exactly one email. UNIQUE(organization_id, trigger_key) still backs it
-- up if two ever tie.
--
-- coalesce on created_at because the column is NULLABLE (default now(), but a
-- caller may pass null). Without it the row comparison yields NULL rather than
-- false, exists() is false, and a late member with a null timestamp would claim
-- as though it were first.
create or replace function public.tg_founder_new_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Is there a member of this org that sorts strictly before me?
  if exists (
    select 1 from public.org_members m
     where m.organization_id = new.organization_id
       and (coalesce(m.created_at,   '-infinity'::timestamptz), m.id)
         < (coalesce(new.created_at, '-infinity'::timestamptz), new.id)
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
  'Founder notification: the EARLIEST member of an organization was created, i.e. somebody signed up. Earliest rather than only, so a multi-row insert still notifies exactly once. Never blocks the signup.';
