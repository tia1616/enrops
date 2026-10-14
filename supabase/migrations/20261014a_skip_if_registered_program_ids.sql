-- A campaign can say "drop anyone already registered for THESE programs" without
-- naming them as what the email is about.
--
-- marketing_recipient_already_enrolled() read only draft_inputs.what.program_ids /
-- camp_session_ids. That works for a campaign whose copy is generated from the
-- picked programs, but a camp campaign cannot pick programs: the send path matches
-- a program to a recipient by SCHOOL NAME, a camp family is reached by AREA, so a
-- recipient with no school match is skipped outright
-- (skipped_no_school_program). Camp campaigns are therefore written as fixed copy
-- with no picks, and "a family that registers stops getting the rest" - the rule
-- the operator asked for on every campaign - had nothing to key on.
--
-- New optional key: draft_inputs.skip_if_registered.program_ids (array of ids). It is
-- UNIONED with what.program_ids, so every existing campaign behaves exactly as
-- before. Camps are matched exactly: the same-site-same-term widening below only
-- ever applies to CLASSES (class_days empty), so a family that booked one camp is
-- not dropped from the campaign for a different camp.
--
-- One predicate, still: get_campaign_recipients and both preview functions already
-- call this function, so they all pick the new key up with no other change.

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
      coalesce(array(
        select jsonb_array_elements_text(coalesce(p_draft_inputs -> 'what' -> 'program_ids', '[]'::jsonb))
        union
        select jsonb_array_elements_text(coalesce(p_draft_inputs -> 'skip_if_registered' -> 'program_ids', '[]'::jsonb))
      )::uuid[], '{}') as program_ids,
      coalesce(array(select jsonb_array_elements_text(
        coalesce(p_draft_inputs -> 'what' -> 'camp_session_ids', '[]'::jsonb)))::uuid[], '{}') as camp_ids
  )
  select exists (
    select 1
    from ids
    cross join registrations rg
    join parents pa on pa.id = rg.parent_id
    where rg.organization_id = p_organization_id
      -- confirmed counts; pending counts for 7 days (the abandoned-registration
      -- window); waitlist counts only for the exact class or camp; refunded and
      -- cancelled never count. See 20261013b for the reasoning.
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
