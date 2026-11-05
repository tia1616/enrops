-- 1. A class cannot go live without a first class date.
-- 2. Copying a class to another term no longer carries its early bird.
--
-- WHY (1): a live class with no first_session_date derives NO dates, so the
-- family who registers sees none on the page, the confirmation or the reminders.
-- It was reachable from two places: the Publish button on a draft (every copy
-- lands as a dateless draft, and the bulk copy makes 25 of them at once), and
-- the quick builder, where a weekly class's start date is optional and Create
-- publishes. On 2026-11-05 prod had one such class live with a paid family.
--
-- Gates only the MOVE into 'open' (an INSERT that publishes, or an UPDATE from
-- any other status), plus clearing the date of a class that is already live.
-- A class that is ALREADY live without a date stays editable, so the operator
-- can add the date - blocking every edit of it would lock them out of the fix.
--
-- Same shape and same SQLSTATE as tg_programs_require_stripe_to_publish, so the
-- frontend's publishErrorMessage passes this message through unchanged.
-- runs_own_registration classes are exempt: families register elsewhere and the
-- enrops listing is not where they get their dates. Backend jobs (service_role)
-- and direct SQL are exempt, as in the Stripe gate - no backend path publishes a
-- class today, and a gate that broke an untraced job would fail the wrong way.

create or replace function public.tg_programs_require_date_to_publish()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.role() is null or auth.role() = 'service_role' then
    return new;
  end if;

  -- status is NULLABLE with DEFAULT 'open': an INSERT that omits it publishes.
  if coalesce(new.status, 'open') <> 'open'
     or new.runs_own_registration is true
     or new.first_session_date is not null then
    return new;
  end if;

  -- Already live with no date: leave it editable. Only a row that is becoming
  -- live, or a live row losing its date, is stopped.
  if tg_op = 'UPDATE'
     and coalesce(old.status, 'open') = 'open'
     and old.first_session_date is null then
    return new;
  end if;

  raise exception 'Add the first class date before you publish. Families need dates to register. Saving as a draft always works.'
    using errcode = 'ENRPS';
end;
$function$;

drop trigger if exists trg_programs_require_date_ins on public.programs;
create trigger trg_programs_require_date_ins
  before insert on public.programs
  for each row execute function public.tg_programs_require_date_to_publish();

drop trigger if exists trg_programs_require_date_upd on public.programs;
create trigger trg_programs_require_date_upd
  before update on public.programs
  for each row execute function public.tg_programs_require_date_to_publish();

-- WHY (2): an early bird belongs to one term's sale. Carrying it copied a fall
-- deadline that had already passed onto a winter draft, and the builder reads a
-- term's early bird from the classes already in it - so a term of copied fall
-- deadlines reads as the wrong early bird. The new term's is set in Discounts.
-- Identical to the live definition (bdbf96f8 on both envs, 2026-11-05) except
-- those two columns, which now insert NULL.
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
    price_cents, null, null, vip_price_cents, 'draft',
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
