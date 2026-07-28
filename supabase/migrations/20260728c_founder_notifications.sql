-- 20260728c_founder_notifications.sql
--
-- FOUNDER NOTIFICATIONS 1.0 (spec: "enrops Founder Notifications", 2026-07-27).
-- Two triggers, one real-time email each, straight to the founder inbox:
--   1. first_registration  - the FIRST enrops-hosted program or camp an operator publishes
--   2. first_transaction   - the FIRST family payment an operator collects
--
-- WHY THIS IS ALL IN THE DATABASE (and not in stripe-webhook / the app):
--   a) REAL-TIME, NOT BATCHED. The spec forbids digests/batching. pg_cron's
--      finest existing granularity here is 5 minutes, which IS batching. A
--      trigger + pg_net POST fires at the moment of the write.
--   b) NO APP-CODE SEAM. Publishing happens as a plain client-side table write
--      (no edge fn to hook), and the payment path is mid-rebuild in another
--      branch. A DB trigger sees every write path - UI, edge fn, cron, backfill,
--      and any future SQL fix - which is exactly what the seam rule demands.
--
-- FIRST-ONLY is enforced by unique (organization_id, trigger_key) on the claim row,
-- not by a count query. That is atomic, race-free, and permanent: two concurrent
-- publishes cannot both win, and a re-publish years later cannot re-fire.
--
-- FAIL-SAFE: every function here swallows its own exceptions. A founder ping must
-- never break a publish or a payment. Worst case is a missing email.
--
-- CONFIG, NOT HARDCODING: the endpoint URL and the gate secret are read from Vault
-- via public.app_secret(), so this migration is byte-identical on staging and prod
-- and each environment points at its own function. Until both secrets exist the
-- dispatch is a silent no-op (claim rows still accumulate, so nothing is lost).

-- ---------------------------------------------------------------------------
-- 1. Internal / test orgs. Prod already carries several throwaway signup orgs;
--    without this every test signup pages the founder.
-- ---------------------------------------------------------------------------
alter table public.organizations
  add column if not exists is_internal boolean not null default false;

comment on column public.organizations.is_internal is
  'True for platform-owned or throwaway test orgs. Suppresses founder notifications. Never affects tenant-facing behaviour.';

-- ---------------------------------------------------------------------------
-- 2. The claim / send-record table. Platform-owner data spanning every tenant,
--    so it is fail-closed: RLS on, NO policies, service_role only. No tenant
--    (and no authenticated user) can read another operator's milestones.
-- ---------------------------------------------------------------------------
create table if not exists public.founder_notifications (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  trigger_key      text not null check (trigger_key in ('first_registration', 'first_transaction')),
  subject_table    text,
  subject_id       uuid,
  occurred_at      timestamptz not null default now(),
  dispatched_at    timestamptz,
  sent_at          timestamptz,
  send_error       text,
  -- Historical marker: this org had already crossed the milestone before 1.0
  -- shipped, so the row exists only to SUPPRESS a false "first". Never sent -
  -- sent_at stays null on purpose, so the record stays honest.
  backfilled       boolean not null default false,
  created_at       timestamptz not null default now(),
  unique (organization_id, trigger_key)
);

comment on table public.founder_notifications is
  'One row per (organization, trigger) - the atomic first-only claim AND the send record for founder notifications. UNIQUE(organization_id, trigger) is what makes "first" mean first.';

create index if not exists founder_notifications_unsent_idx
  on public.founder_notifications (created_at)
  where sent_at is null and not backfilled;

alter table public.founder_notifications enable row level security;
-- Deliberately NO policies: nothing but service_role may read or write.
revoke all on public.founder_notifications from anon, authenticated;
grant select, insert, update on public.founder_notifications to service_role;

-- ---------------------------------------------------------------------------
-- 3. Dispatch: hand the claim to the founder-notify edge function via pg_net.
--    net.http_post only QUEUES the request, so this never blocks the operator's
--    transaction.
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_founder_notification(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, net
as $$
declare
  v_url    text;
  v_secret text;
begin
  v_url    := public.app_secret('founder_notify_url');
  v_secret := public.app_secret('founder_notify_secret');
  -- Not configured yet (or configured on one env only): stay silent. The claim
  -- row survives, so a later backfill can still send it.
  if v_url is null or v_secret is null then
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || v_secret),
    body    := jsonb_build_object('notification_id', p_id)
  );

  update public.founder_notifications set dispatched_at = now() where id = p_id;
exception when others then
  -- Telemetry/notification must never break the operational write.
  null;
end;
$$;

revoke all on function public.dispatch_founder_notification(uuid) from public, anon, authenticated;
grant execute on function public.dispatch_founder_notification(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Claim: returns the new row's id ONLY when this really is the org's first.
--    Returns null when the org is internal, or when the milestone was already
--    claimed (ON CONFLICT DO NOTHING - no UPDATE policy needed).
-- ---------------------------------------------------------------------------
create or replace function public.claim_founder_notification(
  p_org           uuid,
  p_trigger       text,
  p_subject_table text,
  p_subject_id    uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_org is null then
    return null;
  end if;

  if exists (select 1 from public.organizations o where o.id = p_org and o.is_internal) then
    return null;
  end if;

  insert into public.founder_notifications (organization_id, trigger_key, subject_table, subject_id)
  values (p_org, p_trigger, p_subject_table, p_subject_id)
  on conflict (organization_id, trigger_key) do nothing
  returning id into v_id;

  return v_id;
exception when others then
  return null;
end;
$$;

revoke all on function public.claim_founder_notification(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_founder_notification(uuid, text, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4b. Does this operator run registration through enrops AT ALL?
--
--     There are TWO independent flags and missing the org-level one is a live
--     bug, not a hypothetical: shoreview-chess and mrs-richelle both carry
--     organizations.uses_enrops_registration = false on prod today. They use
--     enrops for scheduling and payroll and run registration elsewhere. Because
--     programs.runs_own_registration defaults to FALSE, gating on the program
--     flag alone would fire "First registration!" the first time either of them
--     published anything.
--
--     Matches the app's own reading of this flag (null/absent means true - see
--     AdminLayout.jsx and ProgramsCalendar.jsx, which both use
--     `uses_enrops_registration !== false`).
-- ---------------------------------------------------------------------------
create or replace function public.org_registers_through_enrops(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select o.uses_enrops_registration from public.organizations o where o.id = p_org),
    true
  );
$$;

revoke all on function public.org_registers_through_enrops(uuid) from public, anon, authenticated;
grant execute on function public.org_registers_through_enrops(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Trigger 1 - FIRST REGISTRATION PUBLISHED.
--
--    NOTE: first_transaction deliberately does NOT take this gate. A
--    payment_completed event only exists because enrops processed the money, so
--    the event is its own proof - even for an operator who registers elsewhere.
--
--    "Published" is table-specific, verified against live data:
--      programs      - status 'open'   (draft -> open is the publish; 12 draft / 86 open)
--      camp_sessions - status 'active' (no draft state exists; a camp is born
--                                       published, so INSERT is the publish)
--
--    "enrops-hosted" = runs_own_registration is not true. A program the operator
--    registers for themselves (or points at external_registration_url) is not a
--    registration enrops ever sees, so it is not the milestone the spec means.
-- ---------------------------------------------------------------------------
create or replace function public.tg_founder_first_program()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if new.status = 'open'
     and (tg_op = 'INSERT' or old.status is distinct from 'open')
     and new.runs_own_registration is not true
     and public.org_registers_through_enrops(new.organization_id)
  then
    v_id := public.claim_founder_notification(new.organization_id, 'first_registration', 'programs', new.id);
    if v_id is not null then
      perform public.dispatch_founder_notification(v_id);
    end if;
  end if;
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists trg_founder_first_program_ins on public.programs;
create trigger trg_founder_first_program_ins
  after insert on public.programs
  for each row execute function public.tg_founder_first_program();

drop trigger if exists trg_founder_first_program_upd on public.programs;
create trigger trg_founder_first_program_upd
  after update of status on public.programs
  for each row execute function public.tg_founder_first_program();

create or replace function public.tg_founder_first_camp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if new.status = 'active'
     and (tg_op = 'INSERT' or old.status is distinct from 'active')
     and new.runs_own_registration is not true
     and public.org_registers_through_enrops(new.organization_id)
  then
    v_id := public.claim_founder_notification(new.organization_id, 'first_registration', 'camp_sessions', new.id);
    if v_id is not null then
      perform public.dispatch_founder_notification(v_id);
    end if;
  end if;
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists trg_founder_first_camp_ins on public.camp_sessions;
create trigger trg_founder_first_camp_ins
  after insert on public.camp_sessions
  for each row execute function public.tg_founder_first_camp();

drop trigger if exists trg_founder_first_camp_upd on public.camp_sessions;
create trigger trg_founder_first_camp_upd
  after update of status on public.camp_sessions
  for each row execute function public.tg_founder_first_camp();

-- ---------------------------------------------------------------------------
-- 6. Trigger 2 - FIRST TRANSACTION.
--
--    Hooked to the intelligence event log rather than to stripe-webhook, on
--    purpose: every payment path (checkout, installments, and anything the
--    in-flight Stripe direct-charges rebuild adds) already funnels through
--    log_enrollment_event(), so this sees them all without touching a single
--    file that build is editing.
-- ---------------------------------------------------------------------------
create or replace function public.tg_founder_first_payment()
returns trigger
language plpgsql
security definer
set search_path = public, intelligence
as $$
declare
  v_id uuid;
begin
  if new.action_type = 'payment_completed' then
    v_id := public.claim_founder_notification(
              new.organization_id, 'first_transaction', 'enrollment_events', new.registration_id);
    if v_id is not null then
      perform public.dispatch_founder_notification(v_id);
    end if;
  end if;
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists trg_founder_first_payment on intelligence.enrollment_events;
create trigger trg_founder_first_payment
  after insert on intelligence.enrollment_events
  for each row execute function public.tg_founder_first_payment();

-- ---------------------------------------------------------------------------
-- 6b. RETRY SWEEP - the safety net for a dispatch that never landed.
--
--     The primary path stays real-time; this is NOT a digest. It exists because
--     a transient failure (edge fn cold-start timeout, Resend blip, secrets not
--     yet configured on a fresh environment) otherwise leaves the claim row
--     unsent FOREVER with nothing watching it. Verified by injecting a dead
--     endpoint: the operator's publish still succeeded and the claim survived,
--     but nothing would ever have retried it.
--
--     Only re-dispatches claims older than 5 minutes, so it can never race the
--     live send that is still in flight. Idempotent by construction: the edge fn
--     no-ops on a row whose sent_at is already set.
--
--     Schedule per environment (values differ, so not committed here):
--       select cron.schedule('founder-notify-retry', '*/15 * * * *',
--         $job$ select public.retry_unsent_founder_notifications() $job$);
-- ---------------------------------------------------------------------------
create or replace function public.retry_unsent_founder_notifications()
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
    select id from public.founder_notifications
     where sent_at is null
       and not backfilled
       and created_at < now() - interval '5 minutes'
       -- Give up after a day rather than retrying a doomed row forever; it stays
       -- in the table, visibly unsent, which is the honest end state.
       and created_at > now() - interval '1 day'
     order by created_at
     limit 50
  loop
    perform public.dispatch_founder_notification(v_row.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.retry_unsent_founder_notifications() from public, anon, authenticated;
grant execute on function public.retry_unsent_founder_notifications() to service_role;

comment on function public.retry_unsent_founder_notifications() is
  'Safety net: re-dispatches founder notification claims that were never delivered. Not a digest - the primary path is the real-time trigger.';

-- ---------------------------------------------------------------------------
-- 7. BACKFILL - the step that makes "first" honest.
--
--    Without this, every org that ALREADY publishes and already takes money
--    (J2S most of all) would fire a bogus "first registration!" on its very next
--    publish. Seeding a suppression row for each org that has already crossed
--    the milestone means only genuinely-new firsts ever ping.
--    Idempotent: re-running changes nothing.
-- ---------------------------------------------------------------------------
insert into public.founder_notifications
  (organization_id, trigger_key, subject_table, subject_id, occurred_at, backfilled)
select distinct on (s.organization_id)
  s.organization_id, 'first_registration', s.src, s.id, s.at, true
from (
  select organization_id, id, created_at as at, 'programs'::text as src
    from public.programs
   where status = 'open' and runs_own_registration is not true and organization_id is not null
  union all
  select organization_id, id, created_at, 'camp_sessions'
    from public.camp_sessions
   where status = 'active' and runs_own_registration is not true and organization_id is not null
) s
-- Same gate as the trigger, and it matters in BOTH directions. Seeding a
-- suppression row for an operator who does not register through enrops today
-- would permanently silence them if they adopt enrops registration later - the
-- exact moment worth knowing about. Leaving them out costs nothing now (the
-- trigger already declines to fire for them) and keeps that future first real.
where public.org_registers_through_enrops(s.organization_id)
order by s.organization_id, s.at
on conflict (organization_id, trigger_key) do nothing;

insert into public.founder_notifications
  (organization_id, trigger_key, subject_table, subject_id, occurred_at, backfilled)
select distinct on (e.organization_id)
  e.organization_id, 'first_transaction', 'enrollment_events', e.registration_id, e.occurred_at, true
from intelligence.enrollment_events e
where e.action_type = 'payment_completed'
  and e.organization_id is not null
  -- The event log carries NO FK to organizations on purpose (it outlives
  -- operational deletes), so an org id in here may no longer exist. Without this
  -- guard the backfill dies on a foreign-key violation.
  and exists (select 1 from public.organizations o where o.id = e.organization_id)
order by e.organization_id, e.occurred_at
on conflict (organization_id, trigger_key) do nothing;
