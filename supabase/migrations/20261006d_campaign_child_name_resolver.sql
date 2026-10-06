-- Marketing sends were quoting the WRONG child, or no child at all.
--
-- ROOT CAUSE (found investigating the 2026-10-01 J2S "Summer 2026 review
-- catch-up" send, where 76/229 subjects read "your child's" and 2 read the
-- literal "Child's"): marketing_recipients.child_first_name is ONE
-- denormalized field per (organization_id, email) CONTACT, written once by
-- auto_add_registrant_to_marketing_list() at a family's FIRST confirmed
-- registration and never overwritten by a later one (it's an
-- ON CONFLICT ... coalesce(excluded.x, existing.x) upsert). For a multi-child
-- family that field can only ever be right about ONE child, and a campaign
-- scoped to a SPECIFIC program/term has no way to ask "which child is on
-- THIS registration" — it just reads the one stale field. The 76 nulls are a
-- separate, already-closed data gap: a single CSV import (source =
-- 'squarespace_summer', 2026-05-06) of J2S's own Squarespace-run camp orders
-- that never carried a child name at all — those contacts have no Enrops
-- registration to resolve against, so "your child" is the honest fallback,
-- not a bug. The 2 literal "Child" rows (Lu, Evans) don't match either
-- known cause (not from that CSV, and no roster student is actually named
-- "Child" for those two families) — reported to Jessica rather than guessed
-- at or silently corrected.
--
-- THE FIX: resolve_registration_child_names() looks at the recipient's ACTUAL
-- confirmed registrations, scoped to:
--   1. the campaign's explicit program_ids / camp_session_ids (draft_inputs
--      -> 'what'), when the campaign was built that way, or
--   2. the recipient's own program_name snapshot (how retroactive catch-up
--      sends like this one are built — see marketing_recipients.program_name
--      + project_enrops_su26_review_campaign), matched against the
--      registration's curriculum text.
-- Falls back to NULL (meaning "couldn't resolve — use the old denormalized
-- field") when neither scope is available, so a plain master-list send is
-- unaffected. Multiple matching siblings return all of their names — the
-- caller joins them ("Ava and Liam"), never picks one arbitrarily.
--
-- get_campaign_recipients now returns resolved_child_first_names alongside
-- the existing child_first_name/child_last_name columns (additive — no
-- existing caller breaks). marketing_campaign_child_name_fallback_preview is
-- new: an authenticated-admin-callable function the Marketing composer uses
-- to show, BEFORE Send is enabled, who will hit the "your child" fallback.

create or replace function public.resolve_registration_child_names(
  p_organization_id uuid,
  p_email text,
  p_program_ids uuid[],
  p_camp_session_ids uuid[],
  p_program_name text
)
returns text[]
language sql
stable
security definer
set search_path to 'public'
as $function$
  with scoped_regs as (
    select r.id, s.first_name
    from registrations r
    join students s on s.id = r.student_id
    join parents  p on p.id = r.parent_id
    left join programs pr on pr.id = r.program_id
    left join camp_sessions cs on cs.id = r.camp_session_id
    where r.organization_id = p_organization_id
      and coalesce(r.status, '') <> 'cancelled'
      and lower(btrim(p.email)) = lower(btrim(p_email))
      and s.first_name is not null and btrim(s.first_name) <> ''
      and (
        -- Scope 1: the campaign named specific programs/camps.
        (
          (coalesce(array_length(p_program_ids, 1), 0) > 0 or coalesce(array_length(p_camp_session_ids, 1), 0) > 0)
          and (r.program_id = any(p_program_ids) or r.camp_session_id = any(p_camp_session_ids))
        )
        or
        -- Scope 2: no explicit program/camp scope, but the recipient carries
        -- a program_name snapshot (the retroactive-catchup shape) — match it
        -- against this registration's curriculum text.
        (
          coalesce(array_length(p_program_ids, 1), 0) = 0
          and coalesce(array_length(p_camp_session_ids, 1), 0) = 0
          and p_program_name is not null and btrim(p_program_name) <> ''
          and lower(btrim(coalesce(cs.curriculum_name, pr.curriculum, ''))) = lower(btrim(p_program_name))
        )
      )
  )
  select case when count(*) = 0 then null
         else array_agg(distinct btrim(first_name) order by btrim(first_name))
         end
  from scoped_regs;
$function$;

comment on function public.resolve_registration_child_names(uuid, text, uuid[], uuid[], text) is
  'For one marketing_recipients row, the real child name(s) on their confirmed registration(s) scoped to a campaign''s program/camp picks, or (when the campaign has none) to the recipient''s own program_name snapshot. NULL means "could not resolve — caller should fall back to the denormalized child_first_name column", never an empty send-time hole. Internal helper, not directly grantable (reads parents/students across the org) — callers are get_campaign_recipients and marketing_campaign_child_name_fallback_preview, both of which gate on org access themselves.';

-- `revoke ... from public` does NOT touch a role's own explicit grant, and
-- Supabase's default privileges grant EXECUTE on a newly CREATEd function to
-- authenticated as well as anon (same shape as the anon-grant trap in
-- feedback_definer_fn_anon_grant_and_fail_open_guard) — revoke both by name,
-- not just public. This function trusts its caller to have already scoped to
-- one org/campaign; it must not be directly callable by any authenticated user.
revoke all on function public.resolve_registration_child_names(uuid, text, uuid[], uuid[], text) from public;
revoke all on function public.resolve_registration_child_names(uuid, text, uuid[], uuid[], text) from anon;
revoke all on function public.resolve_registration_child_names(uuid, text, uuid[], uuid[], text) from authenticated;
grant execute on function public.resolve_registration_child_names(uuid, text, uuid[], uuid[], text) to service_role;

-- ── get_campaign_recipients: add resolved_child_first_names ────────────────
-- Return shape changed (new column) so this needs drop+create, not a bare
-- CREATE OR REPLACE. service_role only, same as before this migration —
-- marketing-touchpoint-send's 'send' mode is its only caller.
drop function if exists public.get_campaign_recipients(uuid);

create function public.get_campaign_recipients(p_campaign_id uuid)
returns table(
  id uuid, email text, parent_name text, child_first_name text, child_last_name text,
  school_name text, program_name text, city text, zip text, geo_segment text, segments text[],
  resolved_child_first_names text[]
)
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
    );
$function$;

comment on function public.get_campaign_recipients(uuid) is
  'Recipients approved for a campaign, plus resolved_child_first_names — the real child(ren) on a registration scoped to this campaign''s program/camp picks or the recipient''s program_name snapshot, NULL when neither applies. service_role only; called by marketing-touchpoint-send mode=send.';

-- Same trap as resolve_registration_child_names above — explicit revoke from
-- authenticated, not just public/anon, or the DROP+CREATE re-opens this to
-- every signed-in user via Supabase's default privileges.
revoke all on function public.get_campaign_recipients(uuid) from public;
revoke all on function public.get_campaign_recipients(uuid) from anon;
revoke all on function public.get_campaign_recipients(uuid) from authenticated;
grant execute on function public.get_campaign_recipients(uuid) to service_role;

-- ── Pre-send fallback preview, for the Marketing composer ───────────────────
-- Same scoping rule as get_campaign_recipients, but authenticated-admin
-- callable and projected down to just what the composer needs to show:
-- which approved recipients would render {{child_first_name}} as the
-- generic "your child" fallback (no resolved registration AND no
-- denormalized name on file) if sent right now.
create or replace function public.marketing_campaign_child_name_fallback_preview(
  p_campaign_id uuid,
  p_organization_id uuid
)
returns table(recipient_id uuid, email text, parent_name text)
language plpgsql
stable
security definer
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
    -- Same skip_enrolled exclusion get_campaign_recipients applies. Without
    -- this a recipient already enrolled (and so never actually sent to) would
    -- still count toward this preview's fallback number — overstating it for
    -- any campaign built with "skip families already in this class" on.
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

comment on function public.marketing_campaign_child_name_fallback_preview(uuid, uuid) is
  'Admin-facing: which of this campaign''s approved recipients would render {{child_first_name}} as the generic "your child" fallback right now. Used by the Marketing composer pre-send check. Caller must can_edit_org() the campaign''s org or be a platform admin.';

revoke all on function public.marketing_campaign_child_name_fallback_preview(uuid, uuid) from public;
revoke all on function public.marketing_campaign_child_name_fallback_preview(uuid, uuid) from anon;
grant execute on function public.marketing_campaign_child_name_fallback_preview(uuid, uuid) to authenticated;
grant execute on function public.marketing_campaign_child_name_fallback_preview(uuid, uuid) to service_role;
