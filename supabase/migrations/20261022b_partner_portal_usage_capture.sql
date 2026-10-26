-- Host logins into usage capture (spec v3 §10, Oct 30 criterion 10: "Host
-- logins are recorded in usage capture").
--
-- Usage capture is intelligence.platform_events, written only through
-- public.log_platform_event() (20260702_platform_events_layer.sql). Until now a
-- partner visit reached audit_events only, and only from the provider DETAIL
-- page, so a host who signed in, read the home table and left was counted
-- nowhere. The home page now logs a visit too (frontend, same commit).
--
-- WHAT A "VISIT" IS. Home and detail both log portal_viewed, so one click-through
-- would write two rows and fill the provider's 25-row activity list with
-- repeats. One portal_viewed per person per partner per 30 minutes: the first
-- page they open counts, the rest of that sitting does not. document_opened is
-- unchanged, every open is its own row.
--
-- THE USAGE ROW is one per person per partner per UTC day (dedupe_key; UTC so
-- no tenant timezone is assumed for a telemetry bucket), which is
-- what "host login used" counts. feature 'partner_portal', action
-- 'host_portal_viewed' (FEATURE.PARTNER_PORTAL / ACTION.HOST_PORTAL_VIEWED in
-- _shared/logPlatformEvent.ts). metadata is IDs and facts only, per the
-- intelligence rules: partner_id and the grant's role, never a name or email.
-- log_platform_event() never throws, so usage capture cannot break the portal.
--
-- Signature and return contract unchanged: true when written (or folded into a
-- visit already logged), false for anything this caller may not log.

create or replace function public.log_partner_portal_event(
  p_partner_id uuid,
  p_action text,
  p_document_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_role text;
begin
  if p_action not in ('portal_viewed', 'document_opened') then
    return false;
  end if;
  select a.organization_id into v_org
  from private.current_partner_access() a
  where a.partner_id = p_partner_id;
  if v_org is null then
    return false;
  end if;

  if p_action = 'document_opened' then
    if p_document_id is null or not exists (
      select 1 from public.provider_documents d
      where d.id = p_document_id
        and d.organization_id = v_org
        and (d.partner_id is null or d.partner_id = p_partner_id)
    ) then
      return false;
    end if;
    insert into public.audit_events (organization_id, partner_id, actor_user_id, actor_role, action, subject_type, subject_id)
    values (v_org, p_partner_id, auth.uid(), 'partner', p_action, 'provider_document', p_document_id);
    return true;
  end if;

  -- portal_viewed
  if not exists (
    select 1 from public.audit_events e
    where e.organization_id = v_org
      and e.partner_id = p_partner_id
      and e.actor_user_id = auth.uid()
      and e.action = 'portal_viewed'
      and e.occurred_at > now() - interval '30 minutes'
  ) then
    insert into public.audit_events (organization_id, partner_id, actor_user_id, actor_role, action)
    values (v_org, p_partner_id, auth.uid(), 'partner', 'portal_viewed');
  end if;

  select a.role into v_role
  from public.partner_portal_access a
  where a.auth_user_id = auth.uid()
    and a.partner_id = p_partner_id
    and a.organization_id = v_org
  order by (a.role = 'host_admin') desc
  limit 1;

  perform public.log_platform_event(
    'partner_portal',
    'host_portal_viewed',
    'success',
    v_org,
    auth.uid(),
    jsonb_build_object('partner_id', p_partner_id, 'role', v_role),
    null,
    'host_portal_viewed:' || auth.uid()::text || ':' || p_partner_id::text || ':'
      || to_char(now() at time zone 'UTC', 'YYYY-MM-DD')
  );
  return true;
end;
$$;

revoke all on function public.log_partner_portal_event(uuid, text, uuid) from public;
revoke all on function public.log_partner_portal_event(uuid, text, uuid) from anon;
grant execute on function public.log_partner_portal_event(uuid, text, uuid) to authenticated;
