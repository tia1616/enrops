-- Follow-up to 20261006d: the 2026-10-01 J2S "Summer 2026 review catch-up"
-- send also sent 229 "how did we do" emails whose star links all read
-- "...how-did-we-do?score=N&p=" with NOTHING after p= — {{program_name_url}}
-- was never an approved token in marketing-touchpoint-send (fixed in this
-- same commit), so every occurrence silently rendered empty. Unlike a blank
-- child name, there is no honest fallback for a missing program on a review
-- link — the GA4 how_did_we_do event and the thank-you page both need it, so
-- an empty p= isn't a lesser version of the email, it's a broken one.
--
-- marketing_campaign_missing_program_name_preview: admin-auth gated (same
-- shape as marketing_campaign_child_name_fallback_preview), scoped to
-- campaigns that actually USE {{program_name}} or {{program_name_url}} in
-- any touchpoint (a plain newsletter with neither token has nothing to
-- block). Returns the approved recipients who have no program_name on file —
-- those ARE the ones whose star links would ship broken. The Marketing
-- composer treats a non-empty result as a hard block, not a warning.
create or replace function public.marketing_campaign_missing_program_name_preview(
  p_campaign_id uuid,
  p_organization_id uuid
)
returns table(recipient_id uuid, email text, parent_name text)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uses_program_name boolean;
begin
  if auth.uid() is null
     or not (can_edit_org(p_organization_id) or is_platform_admin()) then
    raise exception 'not_authorised_for_org' using errcode = 'MK001';
  end if;

  if not exists (
    select 1 from marketing_campaigns mc
    where mc.id = p_campaign_id and mc.organization_id = p_organization_id
  ) then
    return;
  end if;

  select exists (
    select 1
    from marketing_campaign_touchpoints tp
    where tp.campaign_id = p_campaign_id
      and tp.organization_id = p_organization_id
      and (
        coalesce(tp.payload ->> 'subject', '') ilike '%{{program_name%'
        or coalesce(tp.payload ->> 'body_html', '') ilike '%{{program_name%'
        or coalesce(tp.payload ->> 'body_text', '') ilike '%{{program_name%'
      )
  ) into v_uses_program_name;

  if not v_uses_program_name then
    return;
  end if;

  return query
  select mr.id, mr.email, mr.parent_name
  from marketing_campaigns mc
  join marketing_recipients mr
    on mr.organization_id = mc.organization_id
   and mr.id = any(mc.approved_recipient_ids)
  where mc.id = p_campaign_id
    and (
      coalesce(mc.draft_inputs -> 'skip_enrolled', 'false'::jsonb) <> 'true'::jsonb
      or not exists (
        select 1
        from registrations rg
        join parents pa on pa.id = rg.parent_id
        where rg.organization_id = mc.organization_id
          and coalesce(rg.status, '') <> 'cancelled'
          and lower(btrim(pa.email)) = lower(btrim(mr.email))
          and (
            rg.program_id::text in (
              select jsonb_array_elements_text(
                coalesce(mc.draft_inputs -> 'what' -> 'program_ids', '[]'::jsonb))
            )
            or rg.camp_session_id::text in (
              select jsonb_array_elements_text(
                coalesce(mc.draft_inputs -> 'what' -> 'camp_session_ids', '[]'::jsonb))
            )
          )
      )
    )
    and (mr.program_name is null or btrim(mr.program_name) = '');
end;
$function$;

comment on function public.marketing_campaign_missing_program_name_preview(uuid, uuid) is
  'Admin-facing: for a campaign whose touchpoints actually reference {{program_name}}/{{program_name_url}}, which approved recipients have no program_name on file and would get a broken (empty &p=) review link. Empty result when no touchpoint uses the token at all. Used by the Marketing composer to hard-block Send, not just warn.';

revoke all on function public.marketing_campaign_missing_program_name_preview(uuid, uuid) from public;
revoke all on function public.marketing_campaign_missing_program_name_preview(uuid, uuid) from anon;
revoke all on function public.marketing_campaign_missing_program_name_preview(uuid, uuid) from authenticated;
grant execute on function public.marketing_campaign_missing_program_name_preview(uuid, uuid) to authenticated;
grant execute on function public.marketing_campaign_missing_program_name_preview(uuid, uuid) to service_role;
