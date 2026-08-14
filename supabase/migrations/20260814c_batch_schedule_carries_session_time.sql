-- 20260814c_batch_schedule_carries_session_time.sql
--
-- derive_program_session_schedule gained a session_time column in 20260814a,
-- but the BATCH wrapper the Scheduled Programs page actually uses builds its own
-- JSON object and was still emitting only {date, kind, reason} -- so the earlier
-- time was present when one program's schedule was re-read after an edit, and
-- absent on first page load. Two paths to the same list, one updated.
--
-- This is the same two-doors shape as the wizard: whatever one path exposes, the
-- other must expose too, or the surface silently disagrees with itself depending
-- on how you got there.
--
-- Additive: a new key in the JSON object. Readers that ignore it are unaffected.

CREATE OR REPLACE FUNCTION public.programs_with_session_schedule(p_organization_id uuid, p_term text)
 RETURNS TABLE(program_id uuid, schedule jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p.id,
    COALESCE(
      (SELECT jsonb_agg(
                jsonb_build_object(
                  'date', s.entry_date,
                  'kind', s.kind,
                  'reason', s.reason,
                  'session_time', s.session_time)
                ORDER BY s.entry_date)
       FROM derive_program_session_schedule(p.id) s),
      '[]'::jsonb)
  FROM programs p
  WHERE p.organization_id = p_organization_id
    AND p.term = p_term;
$function$;

COMMENT ON FUNCTION public.programs_with_session_schedule(uuid, text) IS
  'Batch form of derive_program_session_schedule for one org+term. Each schedule entry is {date, kind, reason, session_time}; session_time is the program''s normal start time, or its early-release start time on a kept early-release date. Must stay in step with derive_program_session_schedule -- the single-program refresh path reads that directly.';
