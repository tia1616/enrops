-- Attendance custody-record integrity: future-date + released/absent guards
-- (three-day code audit 2026-07-12, findings P1#2 and P1#3).
--
-- attendance_records is a custody / compliance log. Two contradictions could be
-- written through the roster UI OR a raw REST call (the trigger is the only
-- tamper-proof gate, so both fixes live here, not just in the UI):
--
--   1. FUTURE DATES. When today is not a meeting day the roster defaults to the
--      next upcoming meeting date, and the record controls were enabled for it.
--      A custody record must reflect a day that has actually happened. Make-up
--      days are recorded on/after they occur, never ahead of time.
--
--   2. "ABSENT BUT RELEASED". A released child was, by definition, present. The
--      prior trigger only set present:=true when present was NULL, so an explicit
--      present=false alongside released_at slipped through, leaving a record the
--      Class Report counts as a release but not as attendance. We now reject that
--      combination so the instructor must undo the release before marking absent.
--
-- CREATE OR REPLACE only (no data change). Fires on new writes; existing rows are
-- untouched until updated. Apply to staging (mumfymlapolsfdnpewci) then prod
-- (iuasfpztkmrtagivlhtj) in the SAME release pass (parity).

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

  -- Integrity 0a: never record a custody entry for a day that hasn't happened.
  IF NEW.session_date > current_date THEN
    RAISE EXCEPTION 'attendance_records: cannot record attendance for a future date (%)', NEW.session_date;
  END IF;

  -- Integrity 0b: a released child was present. A release with no present flag
  -- implies present; an explicit present=false alongside a release is a
  -- contradictory record and is rejected (undo the release before marking absent).
  IF NEW.released_at IS NOT NULL THEN
    IF NEW.present IS NULL THEN
      NEW.present := true;
    ELSIF NEW.present IS NOT TRUE THEN
      RAISE EXCEPTION 'attendance_records: a released child cannot be marked absent (clear the release first)';
    END IF;
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
