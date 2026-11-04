-- "Already registered" is a question about a HOUSEHOLD, not about one inbox.
--
-- marketing_recipient_already_enrolled() matched the recipient's address against
-- parents.email of the registration's parent only. A family that registered under
-- one parent still has a second guardian whose address sits on the child
-- (student_contacts, role 'guardian'), and that second guardian was mailed
-- "register now" for a class the household already holds. Found 2026-11-04 on the
-- "Early bird ends tonight" resend: nhoxmeier@gmail.com is a guardian contact on a
-- confirmed registration and the old predicate said "not enrolled".
--
-- One predicate, still: get_campaign_recipients and both preview functions call
-- this function, so they all pick the household rule up with no other change.
--
-- A registration's household addresses are:
--   1. parents.email of registrations.parent_id            (what it matched before)
--   2. parents.email of students.parent_id for the child   (the two can differ)
--   3. student_contacts.email, role = 'guardian', for the child
-- Deliberately NOT authorized_pickup or do_not_release: a neighbour who collects a
-- child, or a person who must never collect one, is not the family, and counting
-- them would silently drop a real prospect from every campaign.
--
-- Everything else is unchanged from 20261014a: the status windows, the
-- program/camp/same-site-same-term matching, SECURITY DEFINER, search_path, and the
-- grants (service_role only - get_campaign_recipients is SECURITY DEFINER and runs
-- it on the caller's behalf).

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
      -- The household rule. NULL p_email matches nothing, as before.
      and exists (
        select 1
        from (
          select pa.email
          from parents pa
          where pa.id = rg.parent_id
          union all
          select pa2.email
          from students st
          join parents pa2 on pa2.id = st.parent_id
          where st.id = rg.student_id
            and st.organization_id = rg.organization_id
          union all
          select sc.email
          from student_contacts sc
          where sc.student_id = rg.student_id
            and sc.organization_id = rg.organization_id
            and sc.role = 'guardian'
        ) hh
        where lower(btrim(hh.email)) = lower(btrim(p_email))
      )
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
