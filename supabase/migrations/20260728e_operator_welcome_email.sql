-- 20260728e_operator_welcome_email.sql
--
-- The Day 1 welcome email, with the founder's video.
--
-- WHY THIS EXISTS: the spec asked to "embed the welcome video into the existing
-- Day 1 first-run letter". There is no Day 1 letter. The only thing a new provider
-- receives today is their sign-in link, and the "first-run" thing in the product is
-- an in-app card, not an email. So the letter has to be built.
--
-- WHEN IT FIRES: when onboarding_completed_at is first set, NOT at signup. At signup
-- the only fact we hold is an email address, so the email could not say anything real.
-- By the time onboarding completes we know the business name, and on prod all five
-- completed onboardings reached that point, so nothing is lost by waiting.
--
-- ONCE, EVER: organizations.welcome_email_sent_at is both the record and the lock.
-- The send is claimed with a conditional UPDATE (see operator-welcome), so two
-- concurrent dispatches cannot both win. Deliberately NOT reusing
-- founder_notifications: that table is founder-facing pings, this is an email to the
-- operator themselves. One honest column beats bending a table whose name would then
-- be a lie.

alter table public.organizations
  add column if not exists welcome_email_sent_at timestamptz;

comment on column public.organizations.welcome_email_sent_at is
  'When the Day 1 welcome email was sent to this provider. Also the once-ever lock: the send is claimed by setting this where it is still null.';

-- ---------------------------------------------------------------------------
-- Dispatch. Same shape as the founder pings: Vault-configured URL + gate secret,
-- so the migration is identical across environments and each points at its own
-- function. Silent no-op until both secrets exist.
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_operator_welcome(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, net
as $$
declare
  v_url    text;
  v_secret text;
begin
  v_url    := public.app_secret('operator_welcome_url');
  v_secret := public.app_secret('operator_welcome_secret');
  if v_url is null or v_secret is null then
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || v_secret),
    body    := jsonb_build_object('organization_id', p_org)
  );
exception when others then
  -- A welcome email must never break the operator finishing setup.
  null;
end;
$$;

revoke all on function public.dispatch_operator_welcome(uuid) from public, anon, authenticated;
grant execute on function public.dispatch_operator_welcome(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Trigger: the moment onboarding is marked complete.
--
-- Guarded on the null -> not-null transition specifically, so re-saving an already
-- onboarded org never re-fires. is_internal is respected for the same reason the
-- founder pings respect it: our own test accounts should not receive a welcome.
-- ---------------------------------------------------------------------------
create or replace function public.tg_operator_welcome_on_onboarded()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.onboarding_completed_at is not null
     and old.onboarding_completed_at is null
     and new.welcome_email_sent_at is null
     and not coalesce(new.is_internal, false)
  then
    perform public.dispatch_operator_welcome(new.id);
  end if;
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists trg_operator_welcome_on_onboarded on public.organizations;
create trigger trg_operator_welcome_on_onboarded
  after update of onboarding_completed_at on public.organizations
  for each row execute function public.tg_operator_welcome_on_onboarded();

-- ---------------------------------------------------------------------------
-- Retry sweep, for the same reason the founder pings have one: a dispatch that
-- never lands would otherwise be lost in silence. Bounded to providers who
-- finished onboarding in the last day so it can never wake up and mail a backlog.
--
-- THIS FUNCTION IS INERT UNTIL IT IS SCHEDULED. Writing it is not the same as
-- running it, and an unscheduled safety net is worse than none because it reads
-- as covered. Self-review caught exactly that on staging. Schedule per environment
-- (values differ, so not committed here):
--   select cron.schedule('operator-welcome-retry', '*/15 * * * *',
--     $job$ select public.retry_unsent_operator_welcome() $job$);
-- ---------------------------------------------------------------------------
create or replace function public.retry_unsent_operator_welcome()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   record;
  v_count integer := 0;
begin
  for v_row in
    select id from public.organizations
     where welcome_email_sent_at is null
       and onboarding_completed_at is not null
       and onboarding_completed_at < now() - interval '5 minutes'
       and onboarding_completed_at > now() - interval '1 day'
       and not coalesce(is_internal, false)
     order by onboarding_completed_at
     limit 50
  loop
    perform public.dispatch_operator_welcome(v_row.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.retry_unsent_operator_welcome() from public, anon, authenticated;
grant execute on function public.retry_unsent_operator_welcome() to service_role;

-- ---------------------------------------------------------------------------
-- BACKFILL GUARD - the step that stops this mailing every existing provider.
--
-- Every org that already finished onboarding is marked as though its welcome was
-- already sent. Without this, the first retry sweep would email all twelve current
-- providers a "welcome to enrops" letter, several of whom have been live for months.
-- Marked with a sentinel timestamp so it is obvious in the data that these were
-- suppressed rather than genuinely delivered.
-- ---------------------------------------------------------------------------
update public.organizations
   set welcome_email_sent_at = '1970-01-01T00:00:00Z'::timestamptz
 where welcome_email_sent_at is null
   and onboarding_completed_at is not null;
