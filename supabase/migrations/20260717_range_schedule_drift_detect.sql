-- 20260717_range_schedule_drift_detect.sql
-- Chunk 4 of range-scheduling: detect when a RANGE program's materialized
-- session_count has gone STALE because a district/location calendar changed
-- AFTER the program was saved.
--
-- Range mode materializes the derived class-day count into programs.session_count
-- at save time (chunk 3), so the existing date engine + pricing + payroll + emails
-- all keep working unchanged. But that count is a snapshot: if a school later adds
-- a no-school day inside [first_session_date, end_date] (or removes one), the TRUE
-- number of class days in the window changes while session_count does not. The
-- count-mode date engine can't see this -- it walks session_count dates from the
-- start, happily past end_date, so nothing flags it.
--
-- This function re-derives the count from the CURRENT calendars for every range
-- program in a term, so the Programs tab can FLAG the drift. Decided design:
-- re-derive + flag, NEVER silently shift the operator's saved schedule (a silent
-- shift would move enrolled families' class dates with no confirmation). The fix
-- is an explicit admin action -- expand the program and re-save, which re-runs the
-- same materialization against the current calendars.
--
-- Read-only, additive, inert: computes, writes nothing. SECURITY INVOKER (default)
-- so RLS on programs applies -- an admin only ever sees their own org's rows.
-- compute_range_session_count() is itself SECURITY INVOKER and reuses the same
-- closure resolvers as count mode, so range + count can never disagree about
-- which dates are no-school days. Least-privilege grants match the other range
-- fns (authenticated + service_role, never anon) per 20260717_revoke_anon_range_fns.

CREATE OR REPLACE FUNCTION public.range_programs_schedule_drift(
  p_organization_id uuid,
  p_term            text
) RETURNS TABLE(program_id uuid, stored_count integer, derived_count integer)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p.id,
         p.session_count,
         public.compute_range_session_count(p.id)
  FROM public.programs p
  WHERE p.organization_id = p_organization_id
    AND p.term            = p_term
    AND p.schedule_mode   = 'range'
    -- Only fully-configured range programs can DRIFT. A range program with a NULL
    -- window (first_session_date/end_date) is not drifted, it is not-yet-scheduled --
    -- e.g. a Copy-to-term duplicate, which keeps schedule_mode='range' + the copied
    -- session_count but resets the window to NULL. Without this guard such a copy
    -- derives to 0 and false-flags as "Schedule out of date" over the correct
    -- "No dates yet -- set a start and end date" empty state. A legitimately saved
    -- range program always has both (handleSave requires them + materializes first).
    AND p.first_session_date IS NOT NULL
    AND p.end_date          IS NOT NULL;
$function$;

REVOKE EXECUTE ON FUNCTION public.range_programs_schedule_drift(uuid, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.range_programs_schedule_drift(uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.range_programs_schedule_drift(uuid, text) IS
  'For every RANGE-mode program in an org+term, returns {program_id, stored_count (the materialized session_count), derived_count (re-derived from the CURRENT district/location calendars)}. The Programs tab flags rows where the two differ -- a calendar change moved the true class-day count since the program was saved. Read-only; admin-only (authenticated). Chunk 4 of range-scheduling.';
