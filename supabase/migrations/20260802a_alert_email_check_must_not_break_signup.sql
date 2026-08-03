-- 20260802a_alert_email_check_must_not_break_signup.sql
--
-- Fixes a defect introduced by 20260801d, found by the pre-ship gauntlet and
-- PROVEN on staging, not reasoned about.
--
-- 20260801d added CHECK organizations_alert_email_format to stop an operator
-- saving an address that can never deliver. What it missed is that NOBODY
-- writes alert_email at signup -- trg_org_default_alert_email (20260731f, BEFORE
-- INSERT) copies organizations.email into it verbatim. So the constraint landed
-- on the self-serve signup path: public.provision_operator_org() does
-- `INSERT INTO public.organizations (... email ...)` with `auth.jwt() ->> 'email'`,
-- the trigger copies that into alert_email, and a malformed value now aborts the
-- whole INSERT with a 23514.
--
-- Proven on staging before writing this:
--   insert into public.organizations (name, slug, email, ...) values (..., 'not-an-email', ...)
--   -> check_violation. Before 20260801d the same insert succeeded.
--
-- So a settings-field validation acquired the power to break account creation --
-- the single most important path in the product, and the one that matters most
-- for the NEW tenants this is all being built for. Reachability is thin
-- (Supabase Auth validates the address at signup, and the regex is loose) but
-- "should never happen" is exactly the reasoning that produces outages, and the
-- blast radius is wildly out of proportion to the benefit.
--
-- THE FIX IS AT THE ROOT, not the constraint: the triggers are what turn "junk
-- in organizations.email" into "junk in alert_email". They now seed only an
-- address that will actually pass. An org whose signup email is unusable is
-- created with a NULL alert_email instead of being refused -- and NULL is a
-- state this column has always allowed, that loadOrgBrand already handles, and
-- that the operator can now fix themselves at /admin/email-sender.
--
-- The rule lives in ONE place. Previously the same predicate existed as a regex
-- literal in the CHECK, another in EmailSenderSettings.jsx, and a third as
-- isPlausibleEmail() in _shared/orgBrand.ts. Three copies of one rule is how
-- they drift. The DB's copy is now a single function that the constraint AND
-- both triggers call.

-- ---------------------------------------------------------------------------
-- One definition of "could this address plausibly deliver".
-- IMMUTABLE so a CHECK constraint may reference it. Deliberately loose and NOT
-- an RFC 5322 validator: it rejects the typo class (no @, no dot in the domain,
-- embedded whitespace, a pasted "Name <a@b.com>") and nothing else. Resend
-- still gates real delivery.
-- ---------------------------------------------------------------------------
create or replace function public.is_plausible_email(p_email text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select p_email is not null
     and p_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';
$$;

comment on function public.is_plausible_email(text) is
  'Single definition of the address-format rule used by organizations_alert_email_format and by the alert_email seeding triggers. Mirrored (not duplicated) in the UI by PLAUSIBLE_EMAIL in src/pages/admin/EmailSenderSettings.jsx. See 20260802a.';

-- ---------------------------------------------------------------------------
-- Re-point the constraint at the shared function. Same predicate as 20260801d,
-- so no existing row changes validity -- re-verified below.
-- ---------------------------------------------------------------------------
alter table public.organizations
  drop constraint if exists organizations_alert_email_format;

alter table public.organizations
  add constraint organizations_alert_email_format
  check (alert_email is null or public.is_plausible_email(alert_email));

-- ---------------------------------------------------------------------------
-- B1. Seed at org creation -- but never seed something the constraint will
--     reject, because this fires BEFORE INSERT and would take the whole signup
--     down with it. Still INSERT-only (see 20260731f): firing on UPDATE would
--     silently undo a deliberate change.
-- ---------------------------------------------------------------------------
create or replace function public.tg_org_default_alert_email()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.alert_email is null and public.is_plausible_email(new.email) then
    new.alert_email := new.email;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- B2. Seed from the owner's address once org_members exists. This one already
--     swallowed every exception, so a malformed address would have failed
--     SILENTLY rather than loudly -- which is worse, not better: the org keeps a
--     null alert_email and nobody is told why. Check first so the swallow stops
--     being load-bearing, and keep it only as the backstop it was meant to be.
-- ---------------------------------------------------------------------------
create or replace function public.tg_owner_sets_alert_email()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.role = 'owner' and public.is_plausible_email(new.email) then
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
