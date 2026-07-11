-- Attendance + Dismissal Log ("Class Reports") — Chunk A: schema + RLS.
-- Spec: docs/specs/attendance-dismissal-log.md
--
-- Additive + EMPTY + inert. Creates one new table, attendance_records, that
-- captures BOTH check-in and dismissal for one (student, class-meeting): who was
-- present and who each child was released to, timestamped. It CONSUMES the
-- release data customizable-registration already built (student_contacts
-- authorized_pickup / do_not_release, students.dismissal_method) — no rework of
-- that feature. No data seeded; no live behavior changes until Chunk B wires the
-- instructor roster columns.
--
-- RLS mirrors the roster access already in place (no hardcoded tenant):
--   * Org members read; org editors (owner/admin/staff) manage fully.
--   * The assigned instructor writes their OWN class's rows (SELECT/INSERT/UPDATE,
--     no DELETE), gated by private.current_instructor_id() on a 'confirmed'
--     camp_assignments / program_assignments row — same gate as
--     instructors_read_camp_rosters / instructors_read_program_rosters.
--   * A substitute writes ONLY the specific date they cover
--     (assignment_substitutions.date = session_date, status in confirmed/taught) —
--     stricter than the whole-session roster READ on purpose: a Tuesday sub marks
--     Tuesday, not the rest of the week.
--   * organization_id is derived from the authoritative class row by a BEFORE
--     trigger, so a writer cannot mis-tag a row into another org's report.
--
-- Applied to staging (mumfymlapolsfdnpewci) first, verified, then prod
-- (iuasfpztkmrtagivlhtj) in the SAME pass (parity). Security advisor run on each.

-- ============================================================================
-- 1. Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.attendance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  registration_id uuid NOT NULL REFERENCES public.registrations(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  -- exactly one of program_id / camp_session_id (mirror registrations)
  program_id uuid NULL REFERENCES public.programs(id) ON DELETE CASCADE,
  camp_session_id uuid NULL REFERENCES public.camp_sessions(id) ON DELETE CASCADE,
  session_date date NOT NULL,
  -- check-in
  present boolean NULL,                         -- null = not marked, true = here, false = absent
  checked_in_at timestamptz NULL,
  checked_in_by uuid NULL REFERENCES public.instructors(id) ON DELETE SET NULL,
  -- dismissal
  dismissal_kind text NULL,                     -- released_to_adult | walked_or_biked | not_dismissed
  released_to_contact_id uuid NULL REFERENCES public.student_contacts(id) ON DELETE SET NULL,
  released_to_name text NULL,                   -- SNAPSHOT: survives contact edit/delete
  released_at timestamptz NULL,
  released_by uuid NULL REFERENCES public.instructors(id) ON DELETE SET NULL,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_records_one_class_chk
    CHECK (num_nonnulls(program_id, camp_session_id) = 1),
  CONSTRAINT attendance_records_dismissal_kind_chk
    CHECK (dismissal_kind IS NULL OR dismissal_kind IN
      ('released_to_adult','walked_or_biked','not_dismissed'))
);

COMMENT ON TABLE public.attendance_records IS
  'One row per (student, class-meeting): check-in (present) + dismissal (who the child was released to, timestamped) for safety/compliance. Consumes student_contacts (authorized_pickup / do_not_release) + students.dismissal_method. released_to_name is a snapshot so history survives contact edits. Additive; written by the assigned instructor (or a sub for the day they cover) and org editors.';
COMMENT ON COLUMN public.attendance_records.present IS
  'null = not marked yet, true = present/checked in, false = absent.';
COMMENT ON COLUMN public.attendance_records.dismissal_kind IS
  'released_to_adult (released_to_contact_id/name set) | walked_or_biked | not_dismissed. null = dismissal not recorded yet.';
COMMENT ON COLUMN public.attendance_records.released_to_name IS
  'Snapshot of who the child was released to at dismissal time. Preserved even if the source student_contacts row is later edited or deleted.';

-- ============================================================================
-- 2. Indexes
-- ============================================================================
-- One attendance record per child per class-meeting (spec: student + class + date).
CREATE UNIQUE INDEX IF NOT EXISTS attendance_records_student_class_date_uidx
  ON public.attendance_records (student_id, COALESCE(program_id, camp_session_id), session_date);

-- Admin report: per program/term daily grid, and per camp/week.
CREATE INDEX IF NOT EXISTS attendance_records_org_program_date_idx
  ON public.attendance_records (organization_id, program_id, session_date)
  WHERE program_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS attendance_records_org_camp_date_idx
  ON public.attendance_records (organization_id, camp_session_id, session_date)
  WHERE camp_session_id IS NOT NULL;

-- Per-student history (future unified student record) + roster join.
CREATE INDEX IF NOT EXISTS attendance_records_student_date_idx
  ON public.attendance_records (student_id, session_date);
CREATE INDEX IF NOT EXISTS attendance_records_registration_idx
  ON public.attendance_records (registration_id);

-- ============================================================================
-- 3. organization_id is authoritative from the class + updated_at maintenance
-- ============================================================================
-- Derive organization_id from the class row on every write so a writer can never
-- mis-file a record into another org (the admin report trusts organization_id).
-- Also keep updated_at fresh. Function scoped to this table (repo convention).
CREATE OR REPLACE FUNCTION public.set_attendance_records_org_and_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  NEW.organization_id := COALESCE(
    (SELECT cs.organization_id FROM public.camp_sessions cs WHERE cs.id = NEW.camp_session_id),
    (SELECT pr.organization_id FROM public.programs pr WHERE pr.id = NEW.program_id),
    NEW.organization_id
  );
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

-- This is a trigger-only function. Triggers fire regardless of EXECUTE grants, so
-- revoke the auto-granted RPC exposure (it must not be callable via /rest/v1/rpc).
REVOKE ALL ON FUNCTION public.set_attendance_records_org_and_timestamp() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS attendance_records_set_org_and_timestamp ON public.attendance_records;
CREATE TRIGGER attendance_records_set_org_and_timestamp
  BEFORE INSERT OR UPDATE ON public.attendance_records
  FOR EACH ROW
  EXECUTE FUNCTION public.set_attendance_records_org_and_timestamp();

-- ============================================================================
-- 4. Grants (explicit — required for Data API access after 2026-10-30)
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.attendance_records TO authenticated;
-- Never read pre-auth; holds dismissal / release detail. Revoke the anon
-- auto-grant Supabase still applies to new public tables until the cutoff.
REVOKE SELECT ON public.attendance_records FROM anon;

ALTER TABLE public.attendance_records ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 5. Instructor write-access helper (centralizes the polymorphic camp/program +
--    substitute logic — mirrors sub_visibility's single-helper approach)
-- ============================================================================
-- True when the CURRENT instructor may mark attendance for the given class on the
-- given date: the confirmed regular instructor of that camp_session/program (any
-- date of their class), OR a substitute confirmed/taught for that exact date.
CREATE OR REPLACE FUNCTION private.instructor_attendance_access(
  p_program_id uuid,
  p_camp_session_id uuid,
  p_session_date date
) RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public','pg_temp'
AS $function$
  SELECT
    -- regular camp instructor (whole session)
    (p_camp_session_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.camp_assignments ca
      WHERE ca.camp_session_id = p_camp_session_id
        AND ca.instructor_id = private.current_instructor_id()
        AND ca.status = 'confirmed'))
    OR
    -- regular program instructor (whole program)
    (p_program_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.program_assignments pa
      WHERE pa.program_id = p_program_id
        AND pa.instructor_id = private.current_instructor_id()
        AND pa.status = 'confirmed'))
    OR
    -- substitute covering this camp on this specific date
    (p_camp_session_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.assignment_substitutions s
      JOIN public.camp_assignments ca
        ON ca.id = s.parent_assignment_id AND s.parent_assignment_type = 'camp'
      WHERE ca.camp_session_id = p_camp_session_id
        AND s.sub_instructor_id = private.current_instructor_id()
        AND s.status IN ('confirmed','taught')
        AND s.date = p_session_date))
    OR
    -- substitute covering this program on this specific date
    (p_program_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.assignment_substitutions s
      JOIN public.program_assignments pa
        ON pa.id = s.parent_assignment_id AND s.parent_assignment_type = 'program'
      WHERE pa.program_id = p_program_id
        AND s.sub_instructor_id = private.current_instructor_id()
        AND s.status IN ('confirmed','taught')
        AND s.date = p_session_date));
$function$;

REVOKE ALL ON FUNCTION private.instructor_attendance_access(uuid,uuid,date) FROM public, anon;
GRANT EXECUTE ON FUNCTION private.instructor_attendance_access(uuid,uuid,date) TO authenticated;

-- ============================================================================
-- 6. RLS policies
-- ============================================================================
-- Dropped-then-created (Postgres has no CREATE POLICY IF NOT EXISTS) so replay-safe.

-- 6a. Org members read (rosters + admin report). attendance_records itself holds
--     no do_not_release rows; that stays gated on student_contacts.
DROP POLICY IF EXISTS attendance_member_read ON public.attendance_records;
CREATE POLICY attendance_member_read ON public.attendance_records
  FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());

-- 6b. Org editors (owner/admin/staff) manage fully — includes corrections + the
--     only DELETE path (safety records aren't instructor-deletable).
DROP POLICY IF EXISTS attendance_editor_write ON public.attendance_records;
CREATE POLICY attendance_editor_write ON public.attendance_records
  FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- 6c. Assigned instructor (or covering sub) reads their class's rows.
DROP POLICY IF EXISTS attendance_instructor_read ON public.attendance_records;
CREATE POLICY attendance_instructor_read ON public.attendance_records
  FOR SELECT
  USING (private.instructor_attendance_access(program_id, camp_session_id, session_date));

-- 6d. Assigned instructor (or covering sub) inserts their class's rows.
DROP POLICY IF EXISTS attendance_instructor_insert ON public.attendance_records;
CREATE POLICY attendance_instructor_insert ON public.attendance_records
  FOR INSERT
  WITH CHECK (private.instructor_attendance_access(program_id, camp_session_id, session_date));

-- 6e. Assigned instructor (or covering sub) updates their class's rows (no DELETE).
DROP POLICY IF EXISTS attendance_instructor_update ON public.attendance_records;
CREATE POLICY attendance_instructor_update ON public.attendance_records
  FOR UPDATE
  USING (private.instructor_attendance_access(program_id, camp_session_id, session_date))
  WITH CHECK (private.instructor_attendance_access(program_id, camp_session_id, session_date));
