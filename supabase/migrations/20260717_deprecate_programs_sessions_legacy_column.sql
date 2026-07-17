-- 20260717_deprecate_programs_sessions_legacy_column.sql
--
-- Step 1 of 2 in retiring programs.sessions (the legacy duplicate of
-- programs.session_count). This step stops every path from READING, WRITING, or
-- COPYING it, and drops its DEFAULT. The column itself is dropped in a separate,
-- later migration once prod has soaked with nothing reading it -- a DROP COLUMN
-- is irreversible, so the two steps stay apart on purpose.
--
-- Dated 20260717 deliberately: it MUST sort after 20260716_duplicate_program.sql,
-- which recreates duplicate_program() WITH `sessions`. Named 20260716_deprecate_*
-- it would sort first ('dep' < 'dup') and a rebuild-from-migrations would silently
-- undo this cleanup.
--
-- Why it has to go rather than stay in sync:
--   `sessions` is nullable DEFAULT 8; `session_count` is NOT NULL DEFAULT 8.
--   Any INSERT that omits `sessions` silently gets 8 -- no error, no warning.
--   That already happened: staging program 84170cb3 ("SEED - Fall Robotics")
--   carries session_count=10 alongside sessions=8.
--
--   That silence is expensive, because `sessions` was not decorative. It fed
--   src/lib/pricing.js -> Register.jsx, where
--       programWindowDays = (sessions - 2) * 7
--   sets the parent's 2nd and 3rd installment CHARGE DATES. A stale 8 on a
--   10-session program bills the final installment two weeks early.
--
-- Backward-compat, measured rather than argued (2026-07-16):
--   prod    : 92 rows, 0 drifted, 0 rows change their resolved value.
--   staging : 96 rows, 1 drifted (the SEED row above); that row's resolved
--             value corrects 8 -> 10, which is the fix, not a regression.
--
-- Readers/writers retired alongside this migration:
--   src/lib/pricing.js:230                        (read -> session_count)
--   src/pages/admin/programs/ProgramWizardNew.jsx (write -> dropped)
--   duplicate_program()                           (copy -> dropped, below)

-- duplicate_program: same body as before, minus `sessions` from the column list
-- and the SELECT. session_count still carries, so a duplicated program keeps its
-- real cadence. first_session_date stays NULL on copy (the new term sets it).
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
    first_session_date, grade_min, grade_max, max_capacity, price_cents,
    early_bird_price_cents, early_bird_deadline, vip_price_cents, status,
    instructor_name, instructor_email, room, notes, price_tier, legacy_price_cents,
    legacy_deadline, vip_returning_price_cents, vip_new_price_cents, organization_id,
    session_count, program_type, age_format, age_min, age_max, short_description,
    instructor_guide_url, curriculum_id, runs_own_registration,
    external_registration_url, list_in_public_catalog
  )
  select
    program_location_id, p_target_term, curriculum, day_of_week, start_time, end_time,
    null, grade_min, grade_max, max_capacity, price_cents,
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

-- Drop the DEFAULT. This is what makes retiring the WRITER safe for clients
-- running a stale bundle.
--
-- The app is a PWA with a precaching service worker, so a parent can be running
-- yesterday's pricing.js, which still reads `prog.sessions || prog.session_count
-- || 8` (Register.jsx fetches programs with select('*'), so the column is in the
-- row). Once the wizard stops writing `sessions`:
--   with DEFAULT 8 : a new session_count=12 program gets sessions=8, and the
--                    stale reader resolves 8 || 12 || 8 -> 8. It then bills
--                    charge 3 at (8-2)*7 = 42 days instead of 70 -- four weeks
--                    early, on a live card.
--   with no DEFAULT: the same row gets sessions=NULL, and the stale reader
--                    resolves NULL || 12 || 8 -> 12. Correct.
-- So NULL is the value that makes old and new code agree. Existing rows keep
-- their value (prod: all 92 already equal session_count), so they are unaffected.
ALTER TABLE public.programs ALTER COLUMN sessions DROP DEFAULT;

-- Make the deprecation visible to anyone reading the schema before the drop.
COMMENT ON COLUMN public.programs.sessions IS
  'DEPRECATED 2026-07-17, pending DROP. Legacy duplicate of session_count. '
  'Nothing reads, writes, or copies it as of this migration -- session_count is '
  'the only source of truth for cadence. DEFAULT dropped on purpose so new rows '
  'are NULL and any stale cached client falls through to session_count rather '
  'than resolving a wrong 8. Do not add readers; do not restore the DEFAULT.';
