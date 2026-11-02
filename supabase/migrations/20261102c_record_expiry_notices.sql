-- Expiry emails for the safety record (spec v3 Nov 6: "expiry emails at 30,
-- 14, 7 and 0 days"; check 5: "Expiry emails reach the provider").
--
-- WHAT EXPIRES. Two things on a provider's record carry a date that turns a
-- partner's chip amber and then red:
--   1. provider documents with expires_on (insurance certificates, agreements,
--      business licenses), on the same rule the chips use;
--   2. each active instructor's cleared background check, completed_on plus the
--      provider's valid_months (private.background_check_valid_months, the same
--      expiry partner_portal_instructors shows; 0 months = never expires).
--
-- WHEN. An item is mentioned once as it enters each window: 30 days, 14, 7,
-- and once on or after its expiry day (tier 0). The tier is the SMALLEST
-- window the item is inside today, in the provider's own timezone, so a cron
-- day that is missed, or a document uploaded with 5 days left, still gets the
-- right single mention rather than a burst of stale ones. Renewing (a new
-- expires_on, or a new completed_on) starts a fresh cycle, because the date is
-- part of the ledger key.
--
-- WHO. Only providers that use the safety record (they have a document on file
-- or have given a partner a login), so a provider who has never opened Partner
-- portal is not sent a new kind of email about its instructors.
--
-- record_expiry_notices is the ledger: one row per item, date and tier that was
-- emailed. record_expiry_due() returns what is due and not yet in the ledger.
-- Both are service_role only; the record-expiry-cron edge function is the one
-- caller. Grants explicit (Supabase 2026-10-30 change).
--
-- SCHEDULE (PROD ONLY, applied out of band like 20260714_delivery_alert_cron_infra;
-- staging is exercised by test-mode calls). The function requires
-- EXPIRY_ALERT_SECRET in x-cron-secret, set per environment:
--   supabase secrets set EXPIRY_ALERT_SECRET=<random> --project-ref iuasfpztkmrtagivlhtj
--   select cron.schedule('record-expiry-daily', '30 15 * * *', $job$
--     select net.http_post(
--       url := 'https://iuasfpztkmrtagivlhtj.supabase.co/functions/v1/record-expiry-cron',
--       headers := jsonb_build_object('Content-Type', 'application/json',
--         'Authorization', 'Bearer <PROD_ANON_KEY>', 'x-cron-secret', '<EXPIRY_ALERT_SECRET>'),
--       body := '{}'::jsonb, timeout_milliseconds := 140000);
--   $job$);
-- 15:30 UTC = 7:30 AM Pacific in winter. To pause: select cron.unschedule('record-expiry-daily');

create table if not exists public.record_expiry_notices (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  subject_type     text not null,
  subject_id       uuid not null,
  expires_on       date not null,
  tier             integer not null,
  sent_at          timestamptz not null default now(),
  recipients       integer not null,
  constraint record_expiry_notices_subject_check check (subject_type in ('document', 'background_check')),
  constraint record_expiry_notices_tier_check check (tier in (30, 14, 7, 0)),
  constraint record_expiry_notices_once unique (subject_type, subject_id, expires_on, tier)
);

alter table public.record_expiry_notices enable row level security;
revoke all on public.record_expiry_notices from public, anon, authenticated;
grant all on public.record_expiry_notices to service_role;

comment on table public.record_expiry_notices is
  'Ledger of expiry emails sent about a provider''s safety record: one row per item, expiry date and tier (30/14/7/0). Written by record-expiry-cron.';

-- What is due. p_today overrides "today" for every provider (tests only).
create or replace function public.record_expiry_due(p_today date default null)
returns table (
  organization_id uuid,
  subject_type text,
  subject_id uuid,
  doc_type text,
  title text,
  partner_name text,
  instructor_name text,
  expires_on date,
  days_left integer,
  tier integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with orgs as (
    select o.id,
           coalesce(p_today, (now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date) as today,
           private.background_check_valid_months(o.id) as months
    from public.organizations o
    where exists (select 1 from public.provider_documents d where d.organization_id = o.id)
       or exists (select 1 from public.partner_portal_access a where a.organization_id = o.id)
  ),
  items as (
    select d.organization_id, 'document'::text as subject_type, d.id as subject_id,
           d.doc_type, d.title, p.partner_name, null::text as instructor_name,
           d.expires_on, (d.expires_on - g.today) as days_left
    from public.provider_documents d
    join orgs g on g.id = d.organization_id
    left join public.partners p on p.id = d.partner_id
    where d.expires_on is not null
      and (d.partner_id is null or coalesce(p.inactive, false) = false)
    union all
    select s.organization_id, 'background_check', i.id,
           null, null, null, btrim(coalesce(i.first_name, '') || ' ' || coalesce(i.last_name, '')),
           (s.background_check_completed_on + make_interval(months => g.months))::date,
           ((s.background_check_completed_on + make_interval(months => g.months))::date - g.today)
    from public.contractor_onboarding_status s
    join orgs g on g.id = s.organization_id
    join public.instructors i on i.id = s.instructor_id and i.organization_id = s.organization_id
    where i.is_active
      and s.checkr_status = 'clear'
      and s.background_check_completed_on is not null
      and g.months > 0
  ),
  tiered as (
    select it.*,
           case when it.days_left <= 0 then 0
                when it.days_left <= 7 then 7
                when it.days_left <= 14 then 14
                else 30 end as tier
    from items it
    where it.days_left <= 30
  )
  select t.organization_id, t.subject_type, t.subject_id, t.doc_type, t.title, t.partner_name,
         t.instructor_name, t.expires_on, t.days_left, t.tier
  from tiered t
  where not exists (
    select 1 from public.record_expiry_notices n
    where n.subject_type = t.subject_type and n.subject_id = t.subject_id
      and n.expires_on = t.expires_on and n.tier = t.tier
  )
  order by t.organization_id, t.expires_on, t.subject_type;
$$;

revoke all on function public.record_expiry_due(date) from public, anon, authenticated;
grant execute on function public.record_expiry_due(date) to service_role;
