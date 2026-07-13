-- Atomic pickup / do-not-release / guardian + dismissal save for one student
-- (three-day code audit 2026-07-12, finding P2 - PickupInfoGate parallel writes).
--
-- PickupInfoGate (and any backfill) previously fired three replace_student_contacts
-- RPCs plus a students update CONCURRENTLY. Each RPC is its own transaction, so
-- moving a person between the pickup and do-not-release lists races: the
-- destination INSERT can run before the source-role DELETE commits, and the
-- student_contacts pickup/DNR exclusion trigger then sees the stale opposite-role
-- row and raises check_violation - nondeterministically, and with the other writes
-- already committed (a partial save the UI reports as a full failure).
--
-- This function does the whole per-student save in ONE transaction: delete all
-- three managed roles first, THEN insert the new lists, THEN set dismissal_method.
-- Because every old row is gone before any insert, no pickup<->DNR move can trip
-- the exclusion trigger on stale state (a genuine same-name-on-both list still
-- rolls the whole unit back, which is correct). Auth mirrors
-- replace_student_contacts exactly (operator can_edit_org OR the student's parent).
--
-- Apply to staging (mumfymlapolsfdnpewci) then prod (iuasfpztkmrtagivlhtj) in the
-- SAME release pass (parity). Additive - the old replace_student_contacts stays
-- for other callers.

CREATE OR REPLACE FUNCTION public.replace_student_pickup_dnr_guardian(
  p_student_id uuid,
  p_organization_id uuid,
  p_pickup jsonb,
  p_do_not_release jsonb,
  p_guardian jsonb,
  p_dismissal_method text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  c   jsonb;
  idx int;
BEGIN
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

  UPDATE public.students
     SET dismissal_method = NULLIF(p_dismissal_method, '')
   WHERE id = p_student_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.replace_student_pickup_dnr_guardian(uuid, uuid, jsonb, jsonb, jsonb, text) TO authenticated;
