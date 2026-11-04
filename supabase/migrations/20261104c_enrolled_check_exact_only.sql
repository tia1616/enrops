-- A campaign can say "drop only the families registered for THESE exact classes".
--
-- marketing_recipient_already_enrolled() widens a class pick to "any class at the
-- same site and term": right for a broad promo ("you are already in a winter class
-- here, you do not need the winter push"), WRONG for a campaign about ONE more
-- class that is explicitly aimed at families already in the first one. The WI27
-- Pokémon Game Makers announcement (2026-11-04) is exactly that: Super Mario
-- families at Bonny Slope are meant to get it, and the widening would have dropped
-- every one of them at send time.
--
-- New optional key: draft_inputs.skip_if_registered.exact_only (boolean). When
-- true, ONLY a registration for a picked program or camp counts. Absent or false
-- = today's behaviour exactly, so every armed campaign is untouched.
--
-- Everything else is unchanged from 20261104b (the household rule, the status
-- windows, SECURITY DEFINER, search_path and the service_role-only grants).

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
        coalesce(p_draft_inputs -> 'what' -> 'camp_session_ids', '[]'::jsonb)))::uuid[], '{}') as camp_ids,
      -- Only the JSON boolean true turns the widening off. Anything else (absent,
      -- false, a string, null) leaves it on: a malformed value must never switch
      -- a campaign into the narrower, more-sending behaviour by accident.
      coalesce((p_draft_inputs -> 'skip_if_registered' -> 'exact_only') = 'true'::jsonb, false) as exact_only
  )
  select exists (
    select 1
    from ids
    cross join registrations rg
    where rg.organization_id = p_organization_id
      and (
        rg.status = 'confirmed'
        or (rg.status = 'pending' and rg.registered_at > now() - interval '7 days')
        or (rg.status = 'waitlist'
            and (rg.program_id = any (ids.program_ids) or rg.camp_session_id = any (ids.camp_ids)))
      )
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
        or (
          not ids.exact_only
          and exists (
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
      )
  );
$function$;

revoke all on function public.marketing_recipient_already_enrolled(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.marketing_recipient_already_enrolled(uuid, text, jsonb) to service_role;
