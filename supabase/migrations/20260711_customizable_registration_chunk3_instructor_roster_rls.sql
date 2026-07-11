-- Customizable Registration — Chunk 3: instructor RLS for rosters.
-- Spec: docs/specs/customizable-registration.md
--
-- Two gaps this fixes so instructors can actually see the new registration data:
--   1. student_contacts had NO instructor policy → instructors saw zero pickup/
--      guardian/emergency/do-not-release info. Jessica's call 2026-07-11:
--      instructors SEE do_not_release too (they enforce it at dismissal), so no
--      role exclusion — all roles for students on a class they're confirmed on.
--   2. The existing instructor roster policies (registrations/students/parents)
--      are CAMP-ONLY (via camp_assignments). The new after-school instructor
--      roster reads by program_id, so add program_assignments-based read
--      policies mirroring the camp ones.
--
-- All additive (new permissive SELECT policies; nothing tightened). Scoped to the
-- instructor's OWN confirmed assignments via private.current_instructor_id().
-- Idempotent (DROP POLICY IF EXISTS first). Applied to staging first, then prod
-- in the SAME pass (parity).

-- 1. student_contacts — instructor read for assigned camp OR program students.
DROP POLICY IF EXISTS instructors_read_roster_student_contacts ON public.student_contacts;
CREATE POLICY instructors_read_roster_student_contacts ON public.student_contacts
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.registrations r
      JOIN public.camp_assignments ca ON ca.camp_session_id = r.camp_session_id
      WHERE r.student_id = student_contacts.student_id
        AND ca.instructor_id = private.current_instructor_id()
        AND ca.status = 'confirmed'
    )
    OR EXISTS (
      SELECT 1 FROM public.registrations r
      JOIN public.program_assignments pa ON pa.program_id = r.program_id
      WHERE r.student_id = student_contacts.student_id
        AND pa.instructor_id = private.current_instructor_id()
        AND pa.status = 'confirmed'
    )
  );

-- 2. registrations — instructor read for after-school (program) rosters.
DROP POLICY IF EXISTS instructors_read_program_rosters ON public.registrations;
CREATE POLICY instructors_read_program_rosters ON public.registrations
  FOR SELECT
  USING (
    program_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.program_assignments pa
      WHERE pa.program_id = registrations.program_id
        AND pa.instructor_id = private.current_instructor_id()
        AND pa.status = 'confirmed'
    )
  );

-- 3. students — instructor read for after-school (program) roster students.
DROP POLICY IF EXISTS instructors_read_program_roster_students ON public.students;
CREATE POLICY instructors_read_program_roster_students ON public.students
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.registrations r
      JOIN public.program_assignments pa ON pa.program_id = r.program_id
      WHERE r.student_id = students.id
        AND pa.instructor_id = private.current_instructor_id()
        AND pa.status = 'confirmed'
    )
  );

-- 4. parents — instructor read for after-school (program) roster parents.
DROP POLICY IF EXISTS instructors_read_program_roster_parents ON public.parents;
CREATE POLICY instructors_read_program_roster_parents ON public.parents
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.registrations r
      JOIN public.program_assignments pa ON pa.program_id = r.program_id
      WHERE r.parent_id = parents.id
        AND pa.instructor_id = private.current_instructor_id()
        AND pa.status = 'confirmed'
    )
  );
