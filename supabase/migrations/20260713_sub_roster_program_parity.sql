-- After-school (program) sub roster access — parity with camp subs.
-- (Camp/after-school instructor-portal parity, gap #3.)
--
-- A confirmed program instructor already reads their roster (instructors_read_
-- program_rosters / instructors_read_roster_student_contacts / instructors_read_
-- program_roster_parents). A program SUB had no roster access at all, so
-- SubDetailView hid the roster for program subs even though two sub emails
-- promise it. This mirrors the CAMP sub model exactly:
--   sub_roster_session_ids() + subs_read_camp_rosters (registrations)
--                            + subs_read_camp_roster_students (students)
--                            + subs_read_camp_roster_parents (parents)
-- Camp subs deliberately do NOT get student_contacts (pickup/DNR) — so neither do
-- program subs. Additive/permissive: adds read access for program subs only.
-- Grants/roles match the camp pattern (authenticated only; not anon).
--
-- Apply to staging (mumfymlapolsfdnpewci) then prod (iuasfpztkmrtagivlhtj) in the
-- SAME release pass (parity).

CREATE OR REPLACE FUNCTION public.sub_roster_program_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select pa.program_id
  from assignment_substitutions s
  join instructors i on i.id = s.sub_instructor_id
  join program_assignments pa
    on pa.id = s.parent_assignment_id and s.parent_assignment_type = 'program'
  where i.auth_user_id = auth.uid()
    and s.status in ('confirmed','taught')
    and current_date <= s.date + 2
    and pa.published_at is not null;
$function$;

REVOKE ALL ON FUNCTION public.sub_roster_program_ids() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.sub_roster_program_ids() TO authenticated;

DROP POLICY IF EXISTS subs_read_program_rosters ON public.registrations;
CREATE POLICY subs_read_program_rosters ON public.registrations
  FOR SELECT TO authenticated
  USING (
    program_id IS NOT NULL
    AND program_id IN (SELECT public.sub_roster_program_ids())
  );

DROP POLICY IF EXISTS subs_read_program_roster_students ON public.students;
CREATE POLICY subs_read_program_roster_students ON public.students
  FOR SELECT TO authenticated
  USING (
    id IN (
      SELECT r.student_id
      FROM public.registrations r
      WHERE r.student_id IS NOT NULL
        AND r.program_id IN (SELECT public.sub_roster_program_ids())
    )
  );

DROP POLICY IF EXISTS subs_read_program_roster_parents ON public.parents;
CREATE POLICY subs_read_program_roster_parents ON public.parents
  FOR SELECT TO authenticated
  USING (
    id IN (
      SELECT r.parent_id
      FROM public.registrations r
      WHERE r.parent_id IS NOT NULL
        AND r.program_id IN (SELECT public.sub_roster_program_ids())
    )
  );
