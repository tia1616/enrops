-- 20261125w: when a class finishes, its partner hears about it (Jessica
-- 2026-11-25: "if payment sharing is on, it should email them that the info
-- is ready once class is done automatically... provider needs to know this
-- happens as well"; agreed: every partner gets sessions held, money only where
-- the provider shares it).
--
-- partner_class_wrapups_due(p_today) lists, per partner LOGIN, each class at
-- its sites that finished 2 to 9 days ago and that login has not been told
-- about. Two days after the last session gives the instructor time to confirm
-- it; nine days is the catch-up window if a run was missed, and means turning
-- this on never announces a class that ended weeks ago.
--
-- The numbers are not recomputed here. Each login's classes and summary are
-- read AS THAT LOGIN through partner_portal_classes and
-- partner_portal_class_summary (the partner_digest_due pattern), so an email
-- can never say more than that person's portal: site-limited logins hear
-- only about their sites, and money appears only when the provider turned
-- payment sharing on for that partner.
--
-- Only logins that have signed in (auth_user_id set): a login nobody has been
-- invited to yet gets nothing. Only during the partner's working hours (9 to
-- 18 in the provider's timezone), so a run just after midnight sends nothing.
--
-- partner_class_wrapup_sends is the ledger, one row per class per recipient
-- ('access:<id>' for a partner login, 'provider' for the provider's copy).
-- partner-marketing-notify-cron claims rows by inserting them, sends, and
-- deletes them again if the send failed.

begin;

create table if not exists public.partner_class_wrapup_sends (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  partner_id      uuid not null references public.partners(id) on delete cascade,
  class_kind      text not null check (class_kind in ('class', 'camp')),
  class_id        uuid not null,
  recipient_key   text not null,
  sent_at         timestamptz not null default now(),
  constraint partner_class_wrapup_sends_once unique (class_kind, class_id, recipient_key)
);
alter table public.partner_class_wrapup_sends enable row level security;
revoke all on public.partner_class_wrapup_sends from public, anon, authenticated;
grant all on public.partner_class_wrapup_sends to service_role;
comment on table public.partner_class_wrapup_sends is
  'One row per finished class per recipient told about it (recipient_key access:<id> or provider). Written by partner-marketing-notify-cron.';

create or replace function public.partner_class_wrapups_due(p_today date default null)
returns table(
  access_id uuid,
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
  v_prev text := current_setting('request.jwt.claims', true);
begin
  for a in
    select pa.id, pa.partner_id, pa.organization_id, pa.auth_user_id, p.partner_name,
           nullif(btrim(c.contact_email::text), '') as email, c.contact_name, o.name as org_name,
           coalesce(o.timezone, 'America/Los_Angeles') as tz
    from public.partner_portal_access pa
    join public.partners p on p.id = pa.partner_id
    join public.partner_contacts c on c.id = pa.contact_id
    join public.organizations o on o.id = pa.organization_id
    where pa.auth_user_id is not null
      and coalesce(p.inactive, false) = false
      and nullif(btrim(c.contact_email::text), '') is not null
    order by pa.created_at
  loop
    -- Working hours in the provider's timezone (a test passes p_today and skips this).
    if p_today is null and extract(hour from (now() at time zone a.tz)) not between 9 and 17 then
      continue;
    end if;
    v_today := coalesce(p_today, (now() at time zone a.tz)::date);

    -- Read as this login.
    perform set_config('request.jwt.claims',
      json_build_object('sub', a.auth_user_id, 'role', 'authenticated')::text, true);

    -- One login's error must not cost everyone else their email.
    begin
      return query
      select a.id, a.organization_id, a.org_name, a.partner_id, a.partner_name, a.email, a.contact_name,
             pc.kind, pc.class_id, pc.title, pc.site, pc.first_date, pc.last_date,
             pc.count_source, pc.enrolled,
             public.partner_portal_class_summary(a.partner_id, pc.kind, pc.class_id)
      from public.partner_portal_classes(a.partner_id) pc
      where pc.status = 'finished'
        and pc.last_date between v_today - 9 and v_today - 2
        and not exists (
          select 1 from public.partner_class_wrapup_sends s
          where s.class_kind = pc.kind and s.class_id = pc.class_id and s.recipient_key = 'access:' || a.id::text);
    exception when others then
      raise warning 'partner_class_wrapups_due: login % skipped: %', a.id, sqlerrm;
    end;
  end loop;

  perform set_config('request.jwt.claims', coalesce(v_prev, ''), true);
end;
$$;
revoke all on function public.partner_class_wrapups_due(date) from public, anon, authenticated;
grant execute on function public.partner_class_wrapups_due(date) to service_role;

commit;
