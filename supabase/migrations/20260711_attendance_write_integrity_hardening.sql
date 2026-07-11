-- Attendance write-integrity hardening (security review 2026-07-11).
--
-- The instructor write RLS on attendance_records gates on class + date but does
-- NOT bind the row's student / registration / released-to contact to that class.
-- The UI is selection-only so it can't be abused, but an authenticated instructor
-- hitting the raw REST API could forge a dismissal record — most dangerously,
-- set released_to_contact_id to any real pickup-contact UUID + dismissal_kind
-- 'released_to_adult' to make an unauthorized release look authorized (which
-- suppresses the "released to someone not on the authorized list" report flag).
-- This is a custody / compliance log, so we validate the bindings in the BEFORE
-- trigger (fires on EVERY write regardless of RLS or API path).
--
-- Also folds in: recording a dismissal implies the child was present (a release
-- with no check-in was showing as "missing check-in" and hiding the release).
--
-- Applied to staging (mumfymlapolsfdnpewci) then prod (iuasfpztkmrtagivlhtj) in
-- the SAME pass (parity). Validation fires only on new writes; existing rows are
-- untouched until updated.

CREATE OR REPLACE FUNCTION public.set_attendance_records_org_and_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  -- organization_id is authoritative from the class row (tamper-proof).
  NEW.organization_id := COALESCE(
    (SELECT cs.organization_id FROM public.camp_sessions cs WHERE cs.id = NEW.camp_session_id),
    (SELECT pr.organization_id FROM public.programs pr WHERE pr.id = NEW.program_id),
    NEW.organization_id
  );
  NEW.updated_at := now();

  -- A recorded dismissal implies the child was present (never a release without a
  -- check-in). Keeps the safety report from mis-flagging it as a missing check-in.
  IF NEW.released_at IS NOT NULL AND NEW.present IS NULL THEN
    NEW.present := true;
  END IF;

  -- Integrity 1: the registration must be THIS student on THIS class. Blocks
  -- writing rows for students who aren't actually enrolled in the class.
  IF NOT EXISTS (
    SELECT 1 FROM public.registrations r
    WHERE r.id = NEW.registration_id
      AND r.student_id = NEW.student_id
      AND ( (NEW.camp_session_id IS NOT NULL AND r.camp_session_id = NEW.camp_session_id)
         OR (NEW.program_id     IS NOT NULL AND r.program_id     = NEW.program_id) )
  ) THEN
    RAISE EXCEPTION 'attendance_records: registration % is not student % on this class',
      NEW.registration_id, NEW.student_id;
  END IF;

  -- Integrity 2: a linked release contact must be an authorized_pickup of THIS
  -- student. Blocks faking an authorized release by pointing released_to_contact_id
  -- at an arbitrary or another child's contact.
  IF NEW.released_to_contact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.student_contacts sc
    WHERE sc.id = NEW.released_to_contact_id
      AND sc.student_id = NEW.student_id
      AND sc.role = 'authorized_pickup'
  ) THEN
    RAISE EXCEPTION 'attendance_records: released_to_contact_id % is not an authorized pickup for student %',
      NEW.released_to_contact_id, NEW.student_id;
  END IF;

  RETURN NEW;
END;
$function$;
