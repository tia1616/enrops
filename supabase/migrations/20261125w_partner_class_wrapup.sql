-- 20261125w: when a class finishes, its partner hears about it (Jessica
-- 2026-11-25: "if payment sharing is on, it should email them that the info
-- is ready once class is done automatically... provider needs to know this
-- happens as well"; agreed: every partner gets sessions held, money only where
-- the provider shares it).
--
-- partner_class_wrapups_due(p_today) lists, per PERSON at a partner (one
-- signed-in auth user, however many contact rows share their email), each
-- class at their sites that finished 2 to 9 days ago and that they have not
-- been told about. Two days gives the instructor time to confirm the last
-- session; nine days is the catch-up window if a run was missed.
--
-- The numbers are not recomputed here. Each person's classes and summary are
-- read AS THAT PERSON through partner_portal_classes and
-- partner_portal_class_summary (the partner_digest_due pattern), so an email
-- can never say more than their portal: site-limited logins hear only about
-- their sites, and money appears only when the provider turned payment
-- sharing on for that partner.
--
-- Only people who have signed in (auth_user_id set): a login nobody has been
-- invited to yet gets nothing. Only 9:00 to 17:59 in the provider's timezone.
-- One organization's error (a bad timezone, anything) skips that person only.
--
-- partner_class_wrapup_sends is the ledger: one row per class per recipient
-- ('user:<auth id>:<partner id>' for a partner person, 'provider' for the
-- provider's copy). The partner rows carry what was sent (payload, to_name),
-- so the provider's copy is built from the ledger, not from one run's memory:
-- a copy that failed is retried, and someone told on a later day is still
-- named. Delivery is at most once: a claim made by a run that dies before
-- sending is never retried (the claim says it went).
--
-- partner_class_wrapup_copies_due() lists classes told to someone in the last
-- 14 days that the provider has no copy row for yet.

begin;

create table if not exists public.partner_class_wrapup_sends (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  partner_id      uuid not null references public.partners(id) on delete cascade,
  class_kind      text not null check (class_kind in ('class', 'camp')),
  class_id        uuid not null,
  recipient_key   text not null,
  to_name         text,
  payload         jsonb,
  sent_at         timestamptz not null default now(),
  constraint partner_class_wrapup_sends_once unique (class_kind, class_id, recipient_key)
);
alter table public.partner_class_wrapup_sends add column if not exists to_name text;
alter table public.partner_class_wrapup_sends add column if not exists payload jsonb;
alter table public.partner_class_wrapup_sends enable row level security;
revoke all on public.partner_class_wrapup_sends from public, anon, authenticated;
grant all on public.partner_class_wrapup_sends to service_role;
comment on table public.partner_class_wrapup_sends is
  'One row per finished class per recipient told about it (recipient_key user:<auth id>:<partner id>, or provider). Written by partner-marketing-notify-cron.';

drop function if exists public.partner_class_wrapups_due(date);
create function public.partner_class_wrapups_due(p_today date default null)
returns table(
  recipient_key text,
  organization_id uuid,
  provider_name text,
  partner_id uuid,
  partner_name text,
  to_email text,
  to_name text,
  class_kind text,
  class_id uuid,
  title text,
  site text,
  first_date date,
  last_date date,
  count_source text,
  enrolled integer,
  summary jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  a record;
  v_today date;
  v_key text;
  v_prev text := current_setting('request.jwt.claims', true);
begin
  -- One row per PERSON per partner: contacts that share an email link to one
  -- auth user, whose portal is the union of their grants anyway.
  for a in
    select distinct on (pa.partner_id, pa.auth_user_id)
           pa.partner_id, pa.organization_id, pa.auth_user_id, p.partner_name,
           nullif(btrim(c.contact_email::text), '') as email, c.contact_name, o.name as org_name,
           o.timezone as tz
    from public.partner_portal_access pa
    join public.partners p on p.id = pa.partner_id
    join public.partner_contacts c on c.id = pa.contact_id
    join public.organizations o on o.id = pa.organization_id
    where pa.auth_user_id is not null
      and coalesce(p.inactive, false) = false
      and nullif(btrim(c.contact_email::text), '') is not null
    order by pa.partner_id, pa.auth_user_id, pa.created_at
  loop
    v_key := 'user:' || a.auth_user_id::text || ':' || a.partner_id::text;
    -- One person's or one organization's error (a bad timezone, anything)
    -- must not cost everyone else their email.
    begin
      -- Working hours in the provider's timezone (a test passes p_today and skips this).
      if p_today is null and extract(hour from (now() at time zone coalesce(nullif(btrim(a.tz), ''), 'America/Los_Angeles'))) not between 9 and 17 then
        continue;
      end if;
      v_today := coalesce(p_today, (now() at time zone coalesce(nullif(btrim(a.tz), ''), 'America/Los_Angeles'))::date);

      -- Read as this person.
      perform set_config('request.jwt.claims',
        json_build_object('sub', a.auth_user_id, 'role', 'authenticated')::text, true);

      return query
      select v_key, a.organization_id, a.org_name, a.partner_id, a.partner_name, a.email, a.contact_name,
             pc.kind, pc.class_id, pc.title, pc.site, pc.first_date, pc.last_date,
             pc.count_source, pc.enrolled,
             public.partner_portal_class_summary(a.partner_id, pc.kind, pc.class_id)
      from public.partner_portal_classes(a.partner_id) pc
      where pc.status = 'finished'
        and pc.last_date between v_today - 9 and v_today - 2
        and not exists (
          select 1 from public.partner_class_wrapup_sends s
          where s.class_kind = pc.kind and s.class_id = pc.class_id and s.recipient_key = v_key);
    exception when others then
      raise warning 'partner_class_wrapups_due: % skipped: %', v_key, sqlerrm;
    end;
  end loop;

  perform set_config('request.jwt.claims', coalesce(v_prev, ''), true);
end;
$$;
revoke all on function public.partner_class_wrapups_due(date) from public, anon, authenticated;
grant execute on function public.partner_class_wrapups_due(date) to service_role;

-- The provider's copies still to send: classes someone at the partner was told
-- about in the last 14 days, with no 'provider' row yet. One row per class:
-- what was sent (the first payload) and every name it went to.
create or replace function public.partner_class_wrapup_copies_due()
returns table(
  organization_id uuid,
  partner_id uuid,
  class_kind text,
  class_id uuid,
  payload jsonb,
  told_names text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.organization_id, s.partner_id, s.class_kind, s.class_id,
         (array_agg(s.payload order by s.sent_at))[1],
         array_agg(distinct coalesce(nullif(btrim(s.to_name), ''), 'a partner login'))
  from public.partner_class_wrapup_sends s
  where s.recipient_key like 'user:%'
    and s.sent_at > now() - interval '14 days'
    and s.payload is not null
    and not exists (
      select 1 from public.partner_class_wrapup_sends p
      where p.class_kind = s.class_kind and p.class_id = s.class_id and p.recipient_key = 'provider')
  group by s.organization_id, s.partner_id, s.class_kind, s.class_id;
$$;
revoke all on function public.partner_class_wrapup_copies_due() from public, anon, authenticated;
grant execute on function public.partner_class_wrapup_copies_due() to service_role;

commit;
