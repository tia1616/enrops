-- SEAM FIX for 20260724c (programs.photo_url).
-- duplicate_program (copy-to-term) enumerates its columns explicitly, so a new
-- column is silently DROPPED unless it is added here too: an operator copying a
-- program to next term would lose the photo with no error and no clue why.
-- Only change vs the previous definition: photo_url added to the column list and
-- the select. Signature, search_path, invoker rights, and the 'draft' status /
-- nulled dates all preserved exactly.
create or replace function public.duplicate_program(p_program_id uuid, p_target_term text)
 returns uuid
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_new_id uuid;
begin
  if p_target_term is null or btrim(p_target_term) = '' then
    raise exception 'p_target_term is required';
  end if;

  insert into programs (
    program_location_id, term, curriculum, day_of_week, start_time, end_time,
    first_session_date, end_date, schedule_mode, grade_min, grade_max, max_capacity,
    price_cents, early_bird_price_cents, early_bird_deadline, vip_price_cents, status,
    instructor_name, instructor_email, room, notes, price_tier, legacy_price_cents,
    legacy_deadline, vip_returning_price_cents, vip_new_price_cents, organization_id,
    session_count, program_type, age_format, age_min, age_max, short_description,
    instructor_guide_url, curriculum_id, runs_own_registration,
    external_registration_url, list_in_public_catalog, photo_url
  )
  select
    program_location_id, p_target_term, curriculum, day_of_week, start_time, end_time,
    null, null, schedule_mode, grade_min, grade_max, max_capacity,
    price_cents, early_bird_price_cents, early_bird_deadline, vip_price_cents, 'draft',
    instructor_name, instructor_email, room, notes, price_tier, legacy_price_cents,
    legacy_deadline, vip_returning_price_cents, vip_new_price_cents, organization_id,
    session_count, program_type, age_format, age_min, age_max, short_description,
    instructor_guide_url, curriculum_id, runs_own_registration,
    external_registration_url, list_in_public_catalog, photo_url
  from programs
  where id = p_program_id
  returning id into v_new_id;

  if v_new_id is null then
    raise exception 'Source program not found or not visible to this user';
  end if;

  return v_new_id;
end;
$function$;
