-- 20260814e_duplicate_program_carries_early_release.sql
--
-- duplicate_program ("Copy to another term") lists its columns explicitly, so
-- the two columns added by 20260814a were silently dropped from every copy.
--
-- THE FAILURE: Jeff sets "we still meet, at 12:45" on his Fall class at
-- Alameda, then copies his 13 PPS classes into Winter. Every copy comes back
-- with the early-release override EMPTY, which means those dates go back to
-- being CANCELLED -- the exact behaviour the whole feature exists to remove. No
-- error, no warning; he would notice weeks later when the dates looked wrong.
--
-- Found by the seam rule, not by a test: "a new field -- who writes it, who
-- reads it, and who RESTORES or COPIES it?" Duplicate-row functions are the ones
-- that get forgotten, because they name their columns and a new column simply
-- is not in the list.
--
-- Copying is the right answer, not clearing: the early-release TIME is a
-- property of this class at this school (it starts when that school dismisses
-- early), not of the term. The DATES it applies to are re-derived per term from
-- that term's calendar, so the copy stays correct. This mirrors start_time and
-- end_time, which the function already copies for the same reason.
--
-- Everything else about the function is unchanged: still nulls first_session_date
-- and end_date, still forces status 'draft'.

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
    external_registration_url, list_in_public_catalog, photo_url
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
