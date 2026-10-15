-- "Copy to another term" carries the class's staffing settings.
--
-- duplicate_program is an explicit-column INSERT ... SELECT, so the columns
-- added in 20261014b (instructors_needed, second_instructor_after_registrations)
-- were silently dropped from every copy: a Tiny Coders class that needs two
-- instructors came back next term needing one. Staffing need belongs to the
-- class at that site, like max_capacity, which is already copied.
--
-- Body is the live definition (identical on prod and staging, md5
-- 3b2539d97b0e151f988b7b50742be602, 2026-10-15) with the two columns added.
-- Still SECURITY INVOKER with the pinned search_path; OR REPLACE keeps the grants.

CREATE OR REPLACE FUNCTION public.duplicate_program(p_program_id uuid, p_target_term text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_new_id uuid;
begin
  if p_target_term is null or btrim(p_target_term) = '' then
    raise exception 'p_target_term is required';
  end if;

  insert into programs (
    program_location_id, term, curriculum, day_of_week, start_time, end_time,
    early_release_start_time, early_release_end_time,
    first_session_date, end_date, schedule_mode, grade_min, grade_max, max_capacity,
    price_cents, early_bird_price_cents, early_bird_deadline, vip_price_cents, status,
    instructor_name, instructor_email, room, notes, price_tier, legacy_price_cents,
    legacy_deadline, vip_returning_price_cents, vip_new_price_cents, organization_id,
    session_count, program_type, age_format, age_min, age_max, short_description,
    instructor_guide_url, curriculum_id, runs_own_registration,
    external_registration_url, list_in_public_catalog, photo_url,
    instructors_needed, second_instructor_after_registrations
  )
  select
    program_location_id, p_target_term, curriculum, day_of_week, start_time, end_time,
    early_release_start_time, early_release_end_time,
    null, null, schedule_mode, grade_min, grade_max, max_capacity,
    price_cents, early_bird_price_cents, early_bird_deadline, vip_price_cents, 'draft',
    instructor_name, instructor_email, room, notes, price_tier, legacy_price_cents,
    legacy_deadline, vip_returning_price_cents, vip_new_price_cents, organization_id,
    session_count, program_type, age_format, age_min, age_max, short_description,
    instructor_guide_url, curriculum_id, runs_own_registration,
    external_registration_url, list_in_public_catalog, photo_url,
    instructors_needed, second_instructor_after_registrations
  from programs
  where id = p_program_id
  returning id into v_new_id;

  if v_new_id is null then
    raise exception 'Source program not found or not visible to this user';
  end if;

  return v_new_id;
end;
$function$;
