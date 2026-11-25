-- 20261125v: tell the other side when flyers are asked for or added
-- (Jessica 2026-11-25: "can enrops email providers when a partner has asked
-- for media? can enrops email partners when they've been uploaded?").
--
-- Before this, a partner's ask only showed on the provider's To do list, and
-- a new flyer only showed when the partner next opened the portal.
--
--   partner_marketing_asks.provider_notified_at   when the provider's owners
--     and admins were told about this ask. NULL = not yet. A trigger clears it
--     whenever the ask's CONTENT changes (wanted, file types, logo, accessible,
--     note), so saving the same form twice never emails twice, and turning an
--     ask on again, or changing what it asks for, does.
--   class_media.partner_notified_at   when the partner's logins were told about
--     this file. A replaced file is a new row (set_class_media deletes and
--     inserts), so a replacement is announced too.
--
-- EVERY EXISTING ROW IS MARKED AS ALREADY NOTIFIED, so turning this on never
-- emails anyone about something that happened before it.
--
-- partner_marketing_notices_due() lists what is waiting, GROUPED so one burst
-- is one email: a group (provider + partner) waits until nothing in it has
-- changed for 10 minutes. Service role only; partner-marketing-notify-cron
-- claims the rows (sets the timestamp where still NULL), sends, and releases
-- on failure. A group nobody can be emailed about (no login covers the site,
-- the class was cancelled, no owner/admin email) comes back with no
-- recipients and is marked done without sending.

begin;

alter table public.partner_marketing_asks add column if not exists provider_notified_at timestamptz;
alter table public.class_media add column if not exists partner_notified_at timestamptz;

update public.partner_marketing_asks set provider_notified_at = now() where provider_notified_at is null;
update public.class_media set partner_notified_at = now() where partner_notified_at is null;

comment on column public.partner_marketing_asks.provider_notified_at is
  'When the provider was emailed about this ask (partner-marketing-notify-cron). NULL = due; cleared when the ask''s content changes.';
comment on column public.class_media.partner_notified_at is
  'When the partner''s logins were emailed about this file (partner-marketing-notify-cron). NULL = due.';

-- Re-arm an ask only when what it asks for changed.
create or replace function private.rearm_marketing_ask_notice()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.wanted is not distinct from old.wanted
     and new.file_types is not distinct from old.file_types
     and new.needs_logo is not distinct from old.needs_logo
     and new.needs_accessible is not distinct from old.needs_accessible
     and new.note is not distinct from old.note then
    return new;  -- same ask (or only the notice timestamp moved)
  end if;
  new.provider_notified_at := null;
  return new;
end;
$$;
revoke all on function private.rearm_marketing_ask_notice() from public, anon, authenticated;

drop trigger if exists partner_marketing_asks_rearm_notice on public.partner_marketing_asks;
create trigger partner_marketing_asks_rearm_notice
  before insert or update on public.partner_marketing_asks
  for each row execute function private.rearm_marketing_ask_notice();

-- Reviewed 2026-11-25 (independent reviewer): only the last 2 days are ever
-- announced (anything older that is still NULL, e.g. made between this
-- migration and the cron being scheduled, is marked done silently); a group
-- also goes once its oldest item has waited an hour, however busy it stays;
-- and an ask row carries its updated_at so the claim takes only the version
-- that was read (an edit mid-run is announced next run, not lost).
drop function if exists public.partner_marketing_notices_due();
create function public.partner_marketing_notices_due()
returns table(
  kind text,                -- 'ask' (to the provider) | 'media' (to the partner)
  organization_id uuid,
  provider_name text,
  partner_id uuid,
  partner_name text,
  item_key text,            -- 'flyer' | 'social_graphic'
  media_id uuid,            -- media only
  class_title text,         -- media only
  site text,                -- media only
  file_types text[],        -- ask only
  needs_logo boolean,       -- ask only
  needs_accessible boolean, -- ask only
  note text,                -- ask only
  updated_at timestamptz,   -- ask only: the version read, for the claim
  to_emails text[]          -- empty = nobody to tell; mark done without sending
)
language sql
stable
security definer
set search_path to ''
as $$
  with ask_groups as (
    select a.organization_id, a.partner_id
    from public.partner_marketing_asks a
    where a.provider_notified_at is null
    group by 1, 2
    having max(a.updated_at) < now() - interval '10 minutes'
        or min(a.updated_at) < now() - interval '60 minutes'
  ),
  media_rows as (
    select m.id, m.organization_id, m.item_key, m.created_at,
           coalesce(pr.curriculum, cs.curriculum_name) as title,
           pl.id as location_id, pl.name as site, pl.partner_id,
           -- Not open yet counts: the partner sees drafts ("Not open yet") and
           -- a flyer is often added before a class opens. Only cancelled is skipped.
           case when m.program_id is not null then pr.status in ('open', 'draft') else cs.status = 'active' end as live
    from public.class_media m
    left join public.programs pr on pr.id = m.program_id
    left join public.camp_sessions cs on cs.id = m.camp_session_id
    left join public.program_locations pl on pl.id = coalesce(pr.program_location_id, cs.location_id)
    where m.partner_notified_at is null
  ),
  media_groups as (
    select r.organization_id, r.partner_id
    from media_rows r
    group by 1, 2
    having max(r.created_at) < now() - interval '10 minutes'
        or min(r.created_at) < now() - interval '60 minutes'
  )
  -- To the provider: the partner asked (only asks that are ON are worded;
  -- an ask turned off is marked done silently by coming back with no one).
  select 'ask', a.organization_id, o.name, a.partner_id, p.partner_name, a.item_key,
         null::uuid, null::text, null::text,
         a.file_types, a.needs_logo, a.needs_accessible, a.note, a.updated_at,
         case when a.wanted and not coalesce(p.inactive, false)
                   and a.updated_at > now() - interval '2 days' then
           coalesce((select array_agg(distinct lower(btrim(m.email)) order by lower(btrim(m.email)))
                     from public.org_members m
                     where m.organization_id = a.organization_id and m.role in ('owner', 'admin')
                       and m.accepted_at is not null and nullif(btrim(m.email), '') is not null), '{}')
         else '{}' end
  from public.partner_marketing_asks a
  join ask_groups g on g.organization_id = a.organization_id and g.partner_id = a.partner_id
  join public.partners p on p.id = a.partner_id
  join public.organizations o on o.id = a.organization_id
  where a.provider_notified_at is null

  union all

  -- To the partner: every login of that partner whose sites cover the class.
  select 'media', r.organization_id, o.name, r.partner_id, p.partner_name, r.item_key,
         r.id, r.title, r.site,
         null::text[], null::boolean, null::boolean, null::text, null::timestamptz,
         case when r.live and r.partner_id is not null and not coalesce(p.inactive, false)
                   and r.created_at > now() - interval '2 days' then
           coalesce((select array_agg(distinct lower(btrim(c.contact_email::text)) order by lower(btrim(c.contact_email::text)))
                     from public.partner_portal_access pa
                     join public.partner_contacts c on c.id = pa.contact_id
                     where pa.partner_id = r.partner_id and pa.organization_id = r.organization_id
                       and pa.auth_user_id is not null
                       and (pa.site_ids is null or r.location_id = any(pa.site_ids))
                       and nullif(btrim(c.contact_email::text), '') is not null), '{}')
         else '{}' end
  from media_rows r
  join media_groups g on g.organization_id = r.organization_id and g.partner_id is not distinct from r.partner_id
  join public.organizations o on o.id = r.organization_id
  left join public.partners p on p.id = r.partner_id;
$$;
revoke all on function public.partner_marketing_notices_due() from public, anon, authenticated;
grant execute on function public.partner_marketing_notices_due() to service_role;

commit;
