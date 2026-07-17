-- 20260717_program_schedule_mode_preserve_in_duplicate.sql
-- SEAM FIX (found in the chunk 0+1 audit): duplicate_program() must carry the
-- new schedule_mode/end_date columns, or "copy to another term" silently drops a
-- range-mode program back to count mode.
--
-- Sorts AFTER 20260717_program_schedule_mode_and_end_date.sql (which adds the
-- columns) -- "_and_end_date" < "_preserve_in_duplicate" lexically -- and after
-- 20260717_deprecate_programs_sessions_legacy_column.sql (which last recreated
-- this function without `sessions`). This is the authoritative definition.
--
-- The two new columns split the same way first_session_date already does in this
-- function:
--   schedule_mode  -> PRESERVED. The operator chose count vs range; a copy to a
--                     new term keeps that choice. (A count copy stays count; a
--                     range copy stays range.)
--   end_date       -> RESET to NULL, exactly like first_session_date. It is a
--                     term-specific date the operator re-enters for the new term.
--                     A copied range program lands as a status='draft' with its
--                     mode intact but its window blank -- the same intermediate
--                     state a copied count program has with a blank first date.
--                     (The "range needs an end_date to OPEN" invariant is enforced
--                     at publish, in a later chunk, not here.)

CREATE OR REPLACE FUNCTION public.duplicate_program(p_program_id uuid, p_target_term text)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
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
    external_registration_url, list_in_public_catalog
  )
  select
    program_location_id, p_target_term, curriculum, day_of_week, start_time, end_time,
    null, null, schedule_mode, grade_min, grade_max, max_capacity,
    price_cents, early_bird_price_cents, early_bird_deadline, vip_price_cents, 'draft',
    instructor_name, instructor_email, room, notes, price_tier, legacy_price_cents,
    legacy_deadline, vip_returning_price_cents, vip_new_price_cents, organization_id,
    session_count, program_type, age_format, age_min, age_max, short_description,
    instructor_guide_url, curriculum_id, runs_own_registration,
    external_registration_url, list_in_public_catalog
  from programs
  where id = p_program_id
  returning id into v_new_id;

  if v_new_id is null then
    raise exception 'Source program not found or not visible to this user';
  end if;

  return v_new_id;
end;
$function$;
