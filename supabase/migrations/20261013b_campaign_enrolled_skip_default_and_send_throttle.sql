-- Two protections on who a campaign email reaches.
--
--   1. A family that has REGISTERED stops getting "register now" mail, by default.
--   2. A family is not mailed again inside the org's minimum gap.
--
-- 1. SKIP-ENROLLED WAS OPT-IN AND NOTHING EVER OPTED IN
--    get_campaign_recipients dropped enrolled families only when
--    draft_inputs.skip_enrolled = true, and no screen or edge function writes that
--    key. So a family that registered after the first email kept getting the rest of
--    the sequence. It is now ON unless a campaign says skip_enrolled = false.
--
--    "Enrolled" is also wider than before. It used to mean "registered for one of
--    the exact programs this campaign lists". For a CLASS campaign it now also means
--    "registered for any class at the same site in the same term" - a family that
--    signed up for Monday Minecraft is not a prospect for Tuesday Pokemon at that
--    school. Camps stay exact (a family that booked one camp week is still a
--    prospect for another), and the rule is scoped to the SAME site, so a sibling at
--    a different school is not dropped.
--
--    The rule lives in ONE function, marketing_recipient_already_enrolled(), called
--    by get_campaign_recipients and by the two preview functions. The previews
--    existed because they must agree with what is sent; three hand-copied copies of
--    the predicate is how they stop agreeing.
--
-- 2. THE THROTTLE WAS A SETTING WITH NOTHING BEHIND IT
--    organizations.email_throttle_days (default 10) was never read. Measured on prod
--    1 Jun - 13 Oct 2026: of 1,479 parents emailed, 469 got 3+ campaign emails in one
--    7-day window, 167 got 4+, one got 8. marketing_throttled_emails() answers "who
--    in this batch was already mailed inside the gap"; the send function holds them
--    back and logs them as status 'throttled' (already allowed by the CHECK).
--
--    The default moves to 3 days and every org still sitting on the old, never-
--    enforced 10 moves with it. Leaving them at 10 would now be enforced: a weekly
--    sender would silently lose most of their sends.
--
-- Both functions are SECURITY DEFINER, so EXECUTE is revoked from PUBLIC *and* from
-- anon/authenticated explicitly: `revoke from public` does not remove the explicit
-- anon grant Supabase's default privileges add, and that gap has leaked before.

-- ── The one shared predicate ──────────────────────────────────────────────────
create or replace function public.marketing_recipient_already_enrolled(
  p_organization_id uuid,
  p_email text,
  p_draft_inputs jsonb
) returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with ids as (
    select
      coalesce(array(select jsonb_array_elements_text(
        coalesce(p_draft_inputs -> 'what' -> 'program_ids', '[]'::jsonb)))::uuid[], '{}') as program_ids,
      coalesce(array(select jsonb_array_elements_text(
        coalesce(p_draft_inputs -> 'what' -> 'camp_session_ids', '[]'::jsonb)))::uuid[], '{}') as camp_ids
  )
  select exists (
    select 1
    from ids
    cross join registrations rg
    join parents pa on pa.id = rg.parent_id
    where rg.organization_id = p_organization_id
      -- WHICH registrations count (a whitelist, not "anything but cancelled": the
      -- CHECK also allows 'refunded' and 'waitlist', and a refunded family is a
      -- prospect, not an enrollee):
      --   confirmed                -> counts
      --   pending, under 7 days    -> counts while the abandoned-registration
      --                               automation is still chasing it (its window,
      --                               resolveAbandonedAudience in lifecycle-
      --                               automations-cron). After that the family is a
      --                               prospect again; dropping them for good on the
      --                               strength of a cart they never paid for is the
      --                               family a deadline reminder exists for.
      --   waitlist                 -> counts ONLY for the exact class/camp they are
      --                               waiting on (see 20260819v: do not say "register
      --                               now" about a class they are queued for). It does
      --                               NOT widen to the whole site, where open seats in
      --                               another class are exactly what they want.
      and (
        rg.status = 'confirmed'
        or (rg.status = 'pending' and rg.registered_at > now() - interval '7 days')
        or (rg.status = 'waitlist'
            and (rg.program_id = any (ids.program_ids) or rg.camp_session_id = any (ids.camp_ids)))
      )
      and lower(btrim(pa.email)) = lower(btrim(p_email))
      and (
        rg.program_id = any (ids.program_ids)
        or rg.camp_session_id = any (ids.camp_ids)
        or exists (
          -- Same site + same term, CLASSES only (class_days empty or null = class).
          select 1
          from programs cp
          join programs pg
            on pg.term = cp.term
           and pg.program_location_id = cp.program_location_id
          where cp.id = any (ids.program_ids)
            and cp.organization_id = p_organization_id
            and cp.term is not null
            and coalesce(cardinality(cp.class_days), 0) = 0
            and coalesce(cardinality(pg.class_days), 0) = 0
            and pg.id = rg.program_id
        )
      )
  );
$function$;

revoke all on function public.marketing_recipient_already_enrolled(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.marketing_recipient_already_enrolled(uuid, text, jsonb) to service_role;

-- ── Families whose registration a PARTNER runs ────────────────────────────────
-- A school or library that runs its own registration (programs / camp_sessions
-- .runs_own_registration = true) hands us a roster. Those parents land on the
-- marketing list automatically, but they cannot register with us, so a "register
-- now" email from us is a dead end that makes the partner look bad. Measured on
-- prod 13 Oct 2026: 48 roster-imported parents at OES, Grass Valley and Zellerbach,
-- all on the list.
--
-- "Partner-run ONLY": excluded when they hold at least one live registration with a
-- partner-run offering and NONE with an offering we run. A family that also has a
-- class we run keeps getting our mail.
--
-- CAMP CAMPAIGNS ARE DIFFERENT (Jessica, 13 Oct 2026): a camp is a J2S-run offering
-- the school's own after-school registration has nothing to do with, so a family
-- whose only partner-run registration is an AFTER-SCHOOL class (OES, Grass Valley,
-- Zellerbach rosters) SHOULD get camp emails. Only a family with a partner-run CAMP
-- (a parks-and-rec or library camp the partner registers) is held out of one.
-- Whether a campaign is a camp campaign is read off its own picks: camp sessions,
-- or programs that are all camps (class_days non-empty), or what.mode = 'camps'.
drop function if exists public.marketing_recipient_partner_run_only(uuid, text);
create or replace function public.marketing_recipient_partner_run_only(
  p_organization_id uuid,
  p_email text,
  p_draft_inputs jsonb
) returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with ids as (
    select
      coalesce(array(select jsonb_array_elements_text(
        coalesce(p_draft_inputs -> 'what' -> 'program_ids', '[]'::jsonb)))::uuid[], '{}') as program_ids,
      coalesce(array(select jsonb_array_elements_text(
        coalesce(p_draft_inputs -> 'what' -> 'camp_session_ids', '[]'::jsonb)))::uuid[], '{}') as camp_ids
  ),
  kind as (
    select (
      cardinality(camp_ids) > 0
      -- coalesce: a campaign with no mode makes this comparison NULL, and
      -- NULL OR false is NULL, which would turn the whole predicate off for every
      -- class campaign (caught by the staging test, not by reading).
      or coalesce((p_draft_inputs -> 'what' ->> 'mode') = 'camps', false)
      or (cardinality(program_ids) > 0 and not exists (
            select 1 from programs cp
            where cp.id = any (program_ids) and coalesce(cardinality(cp.class_days), 0) = 0))
    ) as is_camp_campaign
    from ids
  ),
  mine as (
    select
      coalesce(p.runs_own_registration, cs.runs_own_registration, false) as partner_run,
      (rg.camp_session_id is not null or coalesce(cardinality(p.class_days), 0) > 0) as is_camp
    from registrations rg
    join parents pa on pa.id = rg.parent_id
    left join programs p on p.id = rg.program_id
    left join camp_sessions cs on cs.id = rg.camp_session_id
    where rg.organization_id = p_organization_id
      and rg.status in ('confirmed', 'pending', 'waitlist')
      and lower(btrim(pa.email)) = lower(btrim(p_email))
  )
  select exists (
           select 1 from mine, kind
           where mine.partner_run and (not kind.is_camp_campaign or mine.is_camp))
     and not exists (select 1 from mine where not partner_run);
$function$;

revoke all on function public.marketing_recipient_partner_run_only(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.marketing_recipient_partner_run_only(uuid, text, jsonb) to service_role;

-- ── get_campaign_recipients: same columns, shared predicate, skip on by default ─
create or replace function public.get_campaign_recipients(p_campaign_id uuid)
 returns table(id uuid, email text, parent_name text, child_first_name text, child_last_name text, school_name text, program_name text, city text, zip text, geo_segment text, segments text[], resolved_child_first_names text[])
 language sql
 security definer
 set search_path to 'public'
as $function$
  select
    mr.id, mr.email, mr.parent_name, mr.child_first_name, mr.child_last_name,
    mr.school_name, mr.program_name, mr.city, mr.zip, mr.geo_segment, mr.segments,
    resolve_registration_child_names(
      mc.organization_id,
      mr.email,
      coalesce(array(select jsonb_array_elements_text(coalesce(mc.draft_inputs -> 'what' -> 'program_ids', '[]'::jsonb)))::uuid[], '{}'),
      coalesce(array(select jsonb_array_elements_text(coalesce(mc.draft_inputs -> 'what' -> 'camp_session_ids', '[]'::jsonb)))::uuid[], '{}'),
      mr.program_name
    )
  from marketing_campaigns mc
  join marketing_recipients mr
    on mr.organization_id = mc.organization_id
   and mr.id = any(mc.approved_recipient_ids)
  where mc.id = p_campaign_id
    and (
      coalesce(mc.draft_inputs -> 'skip_enrolled', 'true'::jsonb) = 'false'::jsonb
      or not marketing_recipient_already_enrolled(mc.organization_id, mr.email, mc.draft_inputs)
    )
    and not marketing_recipient_partner_run_only(mc.organization_id, mr.email, mc.draft_inputs);
$function$;

-- ── the two previews: same predicate, so the count matches what is sent ───────
create or replace function public.marketing_campaign_child_name_fallback_preview(p_campaign_id uuid, p_organization_id uuid)
 returns table(recipient_id uuid, email text, parent_name text)
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
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

  return query
  select mr.id, mr.email, mr.parent_name
  from marketing_campaigns mc
  join marketing_recipients mr
    on mr.organization_id = mc.organization_id
   and mr.id = any(mc.approved_recipient_ids)
  where mc.id = p_campaign_id
    and (
      coalesce(mc.draft_inputs -> 'skip_enrolled', 'true'::jsonb) = 'false'::jsonb
      or not marketing_recipient_already_enrolled(mc.organization_id, mr.email, mc.draft_inputs)
    )
    and not marketing_recipient_partner_run_only(mc.organization_id, mr.email, mc.draft_inputs)
    and coalesce(array_length(
          resolve_registration_child_names(
            mc.organization_id,
            mr.email,
            coalesce(array(select jsonb_array_elements_text(coalesce(mc.draft_inputs -> 'what' -> 'program_ids', '[]'::jsonb)))::uuid[], '{}'),
            coalesce(array(select jsonb_array_elements_text(coalesce(mc.draft_inputs -> 'what' -> 'camp_session_ids', '[]'::jsonb)))::uuid[], '{}'),
            mr.program_name
          ), 1), 0) = 0
    and (mr.child_first_name is null or btrim(mr.child_first_name) = '');
end;
$function$;

create or replace function public.marketing_campaign_missing_program_name_preview(p_campaign_id uuid, p_organization_id uuid)
 returns table(recipient_id uuid, email text, parent_name text)
 language plpgsql
 stable security definer
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
      coalesce(mc.draft_inputs -> 'skip_enrolled', 'true'::jsonb) = 'false'::jsonb
      or not marketing_recipient_already_enrolled(mc.organization_id, mr.email, mc.draft_inputs)
    )
    and not marketing_recipient_partner_run_only(mc.organization_id, mr.email, mc.draft_inputs)
    and (mr.program_name is null or btrim(mr.program_name) = '');
end;
$function$;

-- ── the throttle ──────────────────────────────────────────────────────────────
create or replace function public.marketing_throttled_emails(
  p_organization_id uuid,
  p_emails text[],
  p_touchpoint_id uuid,
  p_gap_hours integer
) returns table(email text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  -- Addresses in p_emails that already received a REAL marketing email from this org
  -- inside the last p_gap_hours. Tests are not mail to a family. The touchpoint being
  -- sent is excluded so a partly-sent touchpoint that re-runs is not held against
  -- itself (its own recipients are already de-duplicated by the caller).
  select distinct lower(btrim(s.email))
  from marketing_sends s
  where s.organization_id = p_organization_id
    and s.is_test is not true
    and s.status in ('sent', 'delivered', 'opened', 'clicked')
    and s.sent_at >= now() - make_interval(hours => greatest(p_gap_hours, 0))
    and s.touchpoint_id is distinct from p_touchpoint_id
    and lower(btrim(s.email)) = any (select lower(btrim(e)) from unnest(p_emails) as e)
    and p_gap_hours > 0;
$function$;

revoke all on function public.marketing_throttled_emails(uuid, text[], uuid, integer) from public, anon, authenticated;
grant execute on function public.marketing_throttled_emails(uuid, text[], uuid, integer) to service_role;

-- ── the default, for new orgs and for every org still on the unenforced 10 ────
alter table public.organizations alter column email_throttle_days set default 3;
update public.organizations set email_throttle_days = 3 where email_throttle_days = 10;
