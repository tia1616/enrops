-- Attendance dismissal: make the account parent + guardians first-class
-- authorized pickup targets.
--
-- Before this, the instructor dismissal picker could only release a child to a
-- student_contacts row with role='authorized_pickup'. The account parent (who
-- lives in `parents`, not `student_contacts`) and second guardians (role
-- 'guardian') were NOT selectable, and recording such a release either failed
-- the write-integrity trigger or got false-flagged in Class Reports as
-- "released to non-authorized". A parent picking up their own child is the
-- single most common case, so this is a correctness gap in the safety report.
--
-- Fix: add a distinct dismissal_kind 'released_to_guardian' so parent/guardian
-- releases are stored as inherently authorized (no data duplication, parent
-- stays single-sourced in `parents`). Broaden the write-integrity trigger to
-- (a) accept guardian contacts on a linked release, (b) validate the
-- account-parent path (null contact_id) against the registration's parent or a
-- guardian of the student, and (c) add an authoritative do-not-release backstop
-- so a barred person is rejected in the DB no matter how the name was entered
-- or which kind is used (guardians + the account parent are NOT covered by the
-- registration-time pickup/dnr overlap constraint, so the DB must guard them
-- here rather than trusting the client's name matching).
--
-- Additive + backward-compatible: only adds a new allowed kind; existing rows
-- (released_to_adult / walked_or_biked / not_dismissed) are untouched.

-- Canonical person-name normalizer: lowercase, collapse ALL whitespace runs
-- (tabs / newlines / non-breaking-adjacent runs) to one space, trim. Used on
-- both sides of every name comparison so messy-roster whitespace never causes a
-- false accept (barred name slips through) or false reject (legit parent
-- blocked). Kept identical to the client's normalization in InstructorPortal.
CREATE OR REPLACE FUNCTION private.norm_person_name(p_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT lower(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')));
$function$;

-- 1. Allow the new kind.
ALTER TABLE public.attendance_records
  DROP CONSTRAINT IF EXISTS attendance_records_dismissal_kind_chk;

ALTER TABLE public.attendance_records
  ADD CONSTRAINT attendance_records_dismissal_kind_chk
  CHECK (
    dismissal_kind IS NULL
    OR dismissal_kind = ANY (ARRAY[
      'released_to_adult'::text,
      'walked_or_biked'::text,
      'not_dismissed'::text,
      'released_to_guardian'::text
    ])
  );

-- 2. Broaden the write-integrity validation for the release target.
CREATE OR REPLACE FUNCTION public.set_attendance_records_org_and_timestamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
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

  -- Integrity 2: validate the release target.
  IF NEW.released_to_contact_id IS NOT NULL THEN
    -- A linked release contact must belong to THIS student and be an authorized
    -- pickup or a guardian (guardians are inherently trusted to collect their
    -- own child). Blocks pointing released_to_contact_id at an arbitrary or
    -- another child's contact.
    IF NOT EXISTS (
      SELECT 1 FROM public.student_contacts sc
      WHERE sc.id = NEW.released_to_contact_id
        AND sc.student_id = NEW.student_id
        AND sc.role IN ('authorized_pickup', 'guardian')
    ) THEN
      RAISE EXCEPTION 'attendance_records: released_to_contact_id % is not an authorized pickup or guardian for student %',
        NEW.released_to_contact_id, NEW.student_id;
    END IF;
  ELSIF NEW.dismissal_kind = 'released_to_guardian' THEN
    -- Account-parent path: the parent lives in `parents`, not student_contacts,
    -- so there is no contact row to link. Guard against laundering an arbitrary
    -- name as an authorized guardian release: the snapshot name must match the
    -- registration's account parent, or a guardian contact of this student.
    IF private.norm_person_name(NEW.released_to_name) = '' THEN
      RAISE EXCEPTION 'attendance_records: released_to_guardian requires released_to_name';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.registrations r
      JOIN public.parents p ON p.id = r.parent_id
      WHERE r.id = NEW.registration_id
        AND private.norm_person_name(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, ''))
            = private.norm_person_name(NEW.released_to_name)
    ) AND NOT EXISTS (
      SELECT 1 FROM public.student_contacts sc
      WHERE sc.student_id = NEW.student_id
        AND sc.role = 'guardian'
        AND private.norm_person_name(coalesce(sc.first_name, '') || ' ' || coalesce(sc.last_name, ''))
            = private.norm_person_name(NEW.released_to_name)
    ) THEN
      RAISE EXCEPTION 'attendance_records: released_to_name "%" is not the account parent or a guardian of student %',
        NEW.released_to_name, NEW.student_id;
    END IF;
  END IF;

  -- Integrity 3: do-not-release backstop. A recorded release must never go to a
  -- do_not_release person for this student, regardless of dismissal_kind or how
  -- the name was entered. The registration-time overlap constraint only blocks
  -- authorized_pickup ∩ do_not_release; guardians and the account parent are
  -- not covered by it, so this is the authoritative custody gate.
  IF NEW.released_at IS NOT NULL
     AND private.norm_person_name(NEW.released_to_name) <> ''
     AND EXISTS (
       SELECT 1 FROM public.student_contacts sc
       WHERE sc.student_id = NEW.student_id
         AND sc.role = 'do_not_release'
         AND private.norm_person_name(coalesce(sc.first_name, '') || ' ' || coalesce(sc.last_name, ''))
             = private.norm_person_name(NEW.released_to_name)
     ) THEN
    RAISE EXCEPTION 'attendance_records: "%" is on the do-not-release list for student % and cannot be released to',
      NEW.released_to_name, NEW.student_id;
  END IF;

  RETURN NEW;
END;
$function$;
