-- replace_student_pickup_dnr_guardian REJECTS "aftercare with no program named".
--
-- WHY THE CLIENT CHECK WAS NOT ENOUGH. Three browser surfaces block the pair
-- (the registration form, Register.jsx's advance guard, and the pickup gate's
-- blocker) through one shared helper. None of them is the write. This function is,
-- and it happily stored ('aftercare', NULL): the CASE below trims the provider to
-- NULL when it is blank and says nothing about it.
--
-- WHAT MADE THAT STICK RATHER THAN SELF-CORRECT. The parent-portal gate is the
-- screen built to collect missing pickup info, and it only pulled in children with
-- NO dismissal answer at all. A child carrying 'aftercare' with a blank provider
-- HAD answered, so the gate skipped them - the one surface that could have asked
-- for the name was the one surface that never would. Every staff surface then read
-- "Aftercare (provider not stated)" indefinitely for a family who did answer.
-- Dashboard.jsx now routes incomplete answers into the gate too, so existing rows
-- repair themselves; this migration stops new ones being written.
--
-- The message is parent-facing. This function is called straight from the gate, and
-- the gate surfaces `e.message` verbatim next to the Save button, so it has to read
-- like a request rather than a constraint name.
--
-- NOT A CHECK CONSTRAINT, deliberately. A table CHECK would also fire on any
-- future backfill or admin script mid-transaction with a raw Postgres error and no
-- route to a good message, and it would forbid the legitimate two-step write
-- (set the method, then the name) that nothing does today but something reasonably
-- might. Guarding the two actual write paths - this function and
-- create-registration - covers every caller that exists while keeping the errors
-- speakable.
--
-- CREATE OR REPLACE keeps the existing ACL (authenticated + service_role, no anon
-- per 20260807c) because the signature is unchanged. Verified by reading proacl
-- back after applying rather than assuming.

create or replace function public.replace_student_pickup_dnr_guardian(
  p_student_id uuid,
  p_organization_id uuid,
  p_pickup jsonb,
  p_do_not_release jsonb,
  p_guardian jsonb,
  p_dismissal_method text,
  -- NO DEFAULT, deliberately. See 20260807b: a default makes the existing 6-arg
  -- call ambiguous against the old signature.
  p_aftercare_provider text
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  c   jsonb;
  idx int;
BEGIN
  -- INPUT VALIDATION FIRST, before the destructive DELETE below. The whole
  -- function is one transaction so a later RAISE would roll back anyway, but
  -- failing before touching contact rows keeps the failure cheap and obvious.
  IF NULLIF(p_dismissal_method, '') = 'aftercare'
     AND btrim(COALESCE(p_aftercare_provider, '')) = '' THEN
    RAISE EXCEPTION 'Please tell us which aftercare program this child goes to.';
  END IF;

  -- student belongs to the org
  IF NOT EXISTS (
    SELECT 1 FROM public.students s
    WHERE s.id = p_student_id AND s.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'student % not in organization %', p_student_id, p_organization_id;
  END IF;

  -- caller is an org editor OR the student's parent
  IF NOT (
    can_edit_org(p_organization_id)
    OR EXISTS (
      SELECT 1 FROM public.students s
      JOIN public.parents pa ON pa.id = s.parent_id
      WHERE s.id = p_student_id AND pa.auth_id = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'not authorized to edit contacts for student %', p_student_id;
  END IF;

  -- delete ALL managed roles first so no stale opposite-role row survives to
  -- trip the pickup/DNR exclusion trigger during the inserts below
  DELETE FROM public.student_contacts
   WHERE student_id = p_student_id
     AND role IN ('authorized_pickup','do_not_release','guardian');

  -- authorized_pickup
  idx := 0;
  FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(p_pickup, '[]'::jsonb))
  LOOP
    INSERT INTO public.student_contacts
      (student_id, organization_id, role, first_name, last_name, phone, email, relationship, notes, sort_order)
    VALUES (p_student_id, p_organization_id, 'authorized_pickup',
            c->>'first_name', c->>'last_name', c->>'phone', c->>'email', c->>'relationship', c->>'notes', idx);
    idx := idx + 1;
  END LOOP;

  -- do_not_release
  idx := 0;
  FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(p_do_not_release, '[]'::jsonb))
  LOOP
    INSERT INTO public.student_contacts
      (student_id, organization_id, role, first_name, last_name, phone, email, relationship, notes, sort_order)
    VALUES (p_student_id, p_organization_id, 'do_not_release',
            c->>'first_name', c->>'last_name', c->>'phone', c->>'email', c->>'relationship', c->>'notes', idx);
    idx := idx + 1;
  END LOOP;

  -- guardian (secondary)
  idx := 0;
  FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(p_guardian, '[]'::jsonb))
  LOOP
    INSERT INTO public.student_contacts
      (student_id, organization_id, role, first_name, last_name, phone, email, relationship, notes, sort_order)
    VALUES (p_student_id, p_organization_id, 'guardian',
            c->>'first_name', c->>'last_name', c->>'phone', c->>'email', c->>'relationship', c->>'notes', idx);
    idx := idx + 1;
  END LOOP;

  -- The provider name is stored ONLY for the aftercare answer, and cleared
  -- otherwise. Same rule the registration form and create-registration enforce:
  -- a name must never outlive the answer it describes, or a roster shows a
  -- destination for a child who now walks home. Enforced here rather than trusted
  -- from the caller, because this is the write.
  UPDATE public.students
     SET dismissal_method  = NULLIF(p_dismissal_method, ''),
         aftercare_provider = CASE
           WHEN NULLIF(p_dismissal_method, '') = 'aftercare'
             THEN NULLIF(btrim(COALESCE(p_aftercare_provider, '')), '')
           ELSE NULL
         END
   WHERE id = p_student_id;
END;
$function$;
