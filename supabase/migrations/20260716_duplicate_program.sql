-- Lets an operator copy an existing program into another term in one click
-- (same location/day/time/curriculum/pricing — just a different term), instead
-- of re-entering everything by hand. New row always lands as status='draft' so
-- it never goes live before the operator reviews/adjusts it, and dates/facility
-- booking are term-specific so they start blank on the copy.
--
-- SECURITY INVOKER (default) — relies entirely on the caller's own RLS grants:
-- members_read_programs to read the source row, members_write_programs to
-- insert the copy. No elevated privilege; a caller can only duplicate a
-- program that's already in their own org, into their own org.
create or replace function public.duplicate_program(p_program_id uuid, p_target_term text)
returns uuid
language plpgsql
as $function$
declare
  v_new_id uuid;
begin
  if p_target_term is null or btrim(p_target_term) = '' then
    raise exception 'p_target_term is required';
  end if;

  insert into programs (
    program_location_id, term, curriculum, day_of_week, start_time, end_time,
    first_session_date, sessions, grade_min, grade_max, max_capacity, price_cents,
    early_bird_price_cents, early_bird_deadline, vip_price_cents, status,
    instructor_name, instructor_email, room, notes, price_tier, legacy_price_cents,
    legacy_deadline, vip_returning_price_cents, vip_new_price_cents, organization_id,
    session_count, program_type, age_format, age_min, age_max, short_description,
    instructor_guide_url, curriculum_id, runs_own_registration,
    external_registration_url, list_in_public_catalog
  )
  select
    program_location_id, p_target_term, curriculum, day_of_week, start_time, end_time,
    null, sessions, grade_min, grade_max, max_capacity, price_cents,
    early_bird_price_cents, early_bird_deadline, vip_price_cents, 'draft',
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
