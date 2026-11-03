-- The Monday digest (spec v3: "email to host admins ... Lists only items
-- expiring within 30 days, items that expired, consent revocations and new
-- providers who shared. No email when nothing changed." Nov 6 check 7).
--
-- WHAT IT LISTS, per host_admin login, for the providers sharing with that
-- partner:
--   - required documents and instructor background checks expiring in the next
--     30 days (including today: the chip still reads "Expiring" on that day);
--   - those that expired in the past 7 days. One that expired earlier was in an
--     earlier digest and has not changed since, so it is not repeated;
--   - instructors who stopped sharing their status in the past 7 days.
-- "New providers who shared" has no source until invites exist (off for all of
-- winter, Arielle 2026-10-28), so it is not listed yet.
--
-- SAME VIEW AS THE PORTAL. For each host_admin the function takes on that
-- person's identity for the rest of this transaction and reads through the
-- same functions their page reads: partner_requirements_for() (only what this
-- partner requires) and partner_portal_instructors() (only instructors at
-- that login's sites who agreed to share, 20261030a). So the digest can never
-- show a host anything its own portal would not. Documents follow the page's
-- rule: those for every partner plus this partner's own.
--
-- partner_digest_sends is the ledger: one row per login per Monday, so a
-- second run that week sends nothing. Both objects are service_role only; the
-- partner-digest-cron edge function is the one caller. Grants explicit
-- (Supabase 2026-10-30 change).
--
-- SCHEDULE (PROD ONLY, applied out of band like 20261102c):
--   supabase secrets set DIGEST_SECRET=<random> --project-ref iuasfpztkmrtagivlhtj
--   select cron.schedule('partner-digest-monday', '0 15 * * 1', $job$
--     select net.http_post(
--       url := 'https://iuasfpztkmrtagivlhtj.supabase.co/functions/v1/partner-digest-cron',
--       headers := jsonb_build_object('Content-Type', 'application/json',
--         'Authorization', 'Bearer <PROD_ANON_KEY>', 'x-cron-secret', '<DIGEST_SECRET>'),
--       body := '{}'::jsonb, timeout_milliseconds := 140000);
--   $job$);
-- 15:00 UTC Monday = 7 AM Pacific in winter. To pause: select cron.unschedule('partner-digest-monday');

create table if not exists public.partner_digest_sends (
  id          uuid primary key default gen_random_uuid(),
  access_id   uuid not null references public.partner_portal_access(id) on delete cascade,
  week_of     date not null,
  sent_at     timestamptz not null default now(),
  recipients  integer not null default 0,
  constraint partner_digest_sends_once unique (access_id, week_of)
);

alter table public.partner_digest_sends enable row level security;
revoke all on public.partner_digest_sends from public, anon, authenticated;
grant all on public.partner_digest_sends to service_role;

comment on table public.partner_digest_sends is
  'Ledger of Monday digests: one row per host_admin login per week. Written by partner-digest-cron.';

-- One row per item to report. p_today overrides "today" (tests only).
create or replace function public.partner_digest_due(p_today date default null)
returns table (
  access_id uuid,
  partner_id uuid,
  partner_name text,
  to_email text,
  week_of date,
  provider_name text,
  kind text,
  label text,
  item_date date
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
  v_week date;
  v_prev text := current_setting('request.jwt.claims', true);
begin
  for a in
    select pa.id, pa.partner_id, pa.organization_id, pa.auth_user_id, p.partner_name,
           c.contact_email::text as contact_email, o.name as org_name, o.timezone
    from public.partner_portal_access pa
    join public.partners p on p.id = pa.partner_id
    join public.partner_contacts c on c.id = pa.contact_id
    join public.organizations o on o.id = pa.organization_id
    where pa.role = 'host_admin'
      and pa.auth_user_id is not null
      and coalesce(p.inactive, false) = false
      and nullif(btrim(c.contact_email::text), '') is not null
    order by pa.created_at
  loop
    v_today := coalesce(p_today, (now() at time zone coalesce(a.timezone, 'America/Los_Angeles'))::date);
    -- The ledger keys on the Monday of this week, so a re-run on any later day
    -- of the same week sends nothing to a login that already got its digest.
    v_week := date_trunc('week', v_today)::date;
    if exists (select 1 from public.partner_digest_sends s where s.access_id = a.id and s.week_of = v_week) then
      continue;
    end if;

    -- Read as this host admin (see the header).
    perform set_config('request.jwt.claims',
      json_build_object('sub', a.auth_user_id, 'role', 'authenticated')::text, true);

    -- One login's error must not cost every other partner its digest.
    begin
    return query
    with req as (
      select r.requirement_key from public.partner_requirements_for(a.partner_id) r where r.required
    ),
    ins as (
      select * from public.partner_portal_instructors(a.partner_id)
    ),
    items as (
      select case when d.expires_on < v_today then 'expired' else 'expiring' end as kind,
             case d.doc_type when 'insurance' then 'Insurance certificate'
                             when 'agreement' then 'Partner agreement'
                             when 'business_license' then 'Business license' end as label,
             d.expires_on as item_date
      from public.provider_documents d
      where d.organization_id = a.organization_id
        and (d.partner_id is null or d.partner_id = a.partner_id)
        and d.expires_on between v_today - 7 and v_today + 30
        and (case d.doc_type when 'insurance' then 'insurance'
                             when 'agreement' then 'partner_agreement'
                             when 'business_license' then 'business_license' end) in (select requirement_key from req)
      union all
      select case when i.background_check_expires_on < v_today then 'expired' else 'expiring' end,
             btrim(coalesce(i.first_name, '') || ' ' || coalesce(i.last_name, '')) || '''s background check',
             i.background_check_expires_on
      from ins i
      where 'background_check' in (select requirement_key from req)
        and i.background_check_expires_on between v_today - 7 and v_today + 30
      union all
      select 'stopped_sharing',
             btrim(coalesce(i.first_name, '') || ' ' || coalesce(i.last_name, '')),
             ist.partner_sharing_stopped_at::date
      from ins i
      join public.instructors ist on ist.id = i.instructor_id
      where not i.shared
        and ist.partner_sharing_stopped_at::date between v_today - 7 and v_today
    )
    select a.id, a.partner_id, a.partner_name, a.contact_email, v_week, a.org_name,
           it.kind, it.label, it.item_date
    from items it
    order by it.kind, it.item_date;
    exception when others then
      raise warning 'partner_digest_due: login % skipped: %', a.id, sqlerrm;
    end;
  end loop;

  perform set_config('request.jwt.claims', coalesce(v_prev, ''), true);
end;
$$;

revoke all on function public.partner_digest_due(date) from public, anon, authenticated;
grant execute on function public.partner_digest_due(date) to service_role;
