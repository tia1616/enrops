-- replace_student_pickup_dnr_guardian stops deleting rows that did not change.
--
-- THE BUG THIS FIXES, reported by a parent (Seth Ring) on 2026-09-03 and
-- reproduced against the live production database the same day.
--
-- A parent opened Student care, changed the AFTERCARE OPTION, and got "Sorry,
-- that didn't save. Please try again." forever. Nothing about their edit was
-- wrong, and no retry could ever work. The chain:
--
--   1. On 31 Aug an instructor marked their child released to a guardian. That
--      wrote an attendance_records row with dismissal_kind='released_to_guardian'
--      and released_to_contact_id pointing at that guardian's student_contacts row.
--   2. This function replaced contacts BY ROLE: one DELETE of every
--      authorized_pickup / do_not_release / guardian row, then re-INSERT from the
--      payload. So a guardian who had not changed at all was still deleted.
--   3. attendance_records.released_to_contact_id is ON DELETE SET NULL, so that
--      DELETE became an UPDATE on attendance_records.
--   4. That UPDATE fired set_attendance_records_org_and_timestamp(), which now saw
--      a NULL contact id with dismissal_kind='released_to_guardian', fell through
--      to its name check, and looked for a guardian row the same statement had
--      just deleted. RAISE -> whole transaction aborts -> nothing saves.
--
-- Measured on prod: 7 students were in that state (6 J2S, 1 Ukulele) across
-- 27 Aug - 2 Sept, one week into term, and the count grew with every guardian
-- release an instructor recorded. Their pointers were cleared by hand on
-- 2026-09-03 to unblock the families; THIS is the fix that stops it recurring.
--
-- THE TRIGGER IS NOT THE BUG AND IS NOT TOUCHED. "A child must not be recorded
-- as released to somebody who is not a guardian" is correct, and a genuine
-- removal of a named guardian must still be refused. What was wrong is that an
-- unrelated edit churned rows it had no reason to touch - the same defect class
-- as the whole-row-writes register.
--
-- WHAT CHANGES: the function now diffs. A contact still on the list is UPDATED
-- IN PLACE, so its id survives, so no FK cascade fires, so the trigger is never
-- re-run for it. Only genuine removals are deleted and only genuinely new rows
-- are inserted.
--
-- ROW IDENTITY is (role, normalised name, duplicate rank), and the name is
-- composed with the EXACT expression the attendance trigger uses -
-- private.norm_person_name(coalesce(first_name,'') || ' ' || coalesce(last_name,''))
-- - so this function's idea of "the same person" cannot drift from the idea held
-- by the check that refuses the write. One rule, one spelling.
--
-- The DUPLICATE RANK exists because nothing stops two contacts sharing a name
-- ("Jim Adams" twice on one pickup list). Ranking both sides by name and joining
-- on the rank keeps the match total and deterministic instead of ambiguous.
--
-- UNCHANGED, deliberately, and each was carried over rather than re-derived:
--   * the aftercare guard (dismissal 'aftercare' with no provider named);
--   * the org guard (student must belong to p_organization_id);
--   * the authorization guard (can_edit_org OR the child's own account parent);
--   * SECURITY DEFINER and search_path = public, pg_temp;
--   * the payload stays AUTHORITATIVE for phone / email / relationship / notes,
--     exactly as the re-insert made it - a field the screen does not send is
--     still cleared. That is the pre-existing contract and this is not the change
--     to alter it in.
--   * the 6-arg overload is left alone. Nothing calls it (careRpcArgs always
--     sends 7 keys) but unreachable is not the same as deletable, and dropping it
--     is a separate decision with its own blast radius.
--
-- The pickup/do-not-release overlap constraint trigger now also fires on the
-- UPDATE path, not only on INSERT. That is a safety net running MORE often, not
-- less: it re-asserts an invariant that has to hold either way, and a genuine
-- overlap is still caught on the row that introduces it. Deletes run FIRST so a
-- name moving from one list to the other cannot collide with its own old row.

create or replace function public.replace_student_pickup_dnr_guardian(
  p_student_id       uuid,
  p_organization_id  uuid,
  p_pickup           jsonb,
  p_do_not_release   jsonb,
  p_guardian         jsonb,
  p_dismissal_method text,
  p_aftercare_provider text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
DECLARE
  v_in jsonb;
BEGIN
  -- ---- guards, carried over verbatim -------------------------------------
  IF NULLIF(p_dismissal_method, '') = 'aftercare'
     AND btrim(COALESCE(p_aftercare_provider, '')) = '' THEN
    RAISE EXCEPTION 'Please tell us which aftercare program this child goes to.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.students s
    WHERE s.id = p_student_id AND s.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'student % not in organization %', p_student_id, p_organization_id;
  END IF;

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

  -- ---- the incoming list, flattened once ---------------------------------
  -- WITH ORDINALITY, not the array index: it is the payload's own order, which
  -- is what sort_order has always meant here.
  SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) INTO v_in
  FROM (
    SELECT jsonb_build_object(
             'role',         r.role,
             'first_name',   e.c->>'first_name',
             'last_name',    e.c->>'last_name',
             'phone',        e.c->>'phone',
             'email',        e.c->>'email',
             'relationship', e.c->>'relationship',
             'notes',        e.c->>'notes',
             'sort_order',   (row_number() OVER (PARTITION BY r.role ORDER BY e.ord) - 1),
             'nm',           private.norm_person_name(
                               coalesce(e.c->>'first_name','') || ' ' || coalesce(e.c->>'last_name','')),
             'dup',          (row_number() OVER (
                               PARTITION BY r.role, private.norm_person_name(
                                 coalesce(e.c->>'first_name','') || ' ' || coalesce(e.c->>'last_name',''))
                               ORDER BY e.ord) - 1)
           ) AS x
    FROM (VALUES
            ('authorized_pickup', COALESCE(p_pickup,         '[]'::jsonb)),
            ('do_not_release',    COALESCE(p_do_not_release, '[]'::jsonb)),
            ('guardian',          COALESCE(p_guardian,       '[]'::jsonb))
         ) AS r(role, arr)
    CROSS JOIN LATERAL jsonb_array_elements(r.arr) WITH ORDINALITY AS e(c, ord)
  ) s;

  -- ---- 1. genuine removals only ------------------------------------------
  -- Ordered by sort_order/created_at/id so the rank is stable across calls
  -- rather than depending on whatever order the heap returns.
  WITH existing AS (
    SELECT sc.id, sc.role,
           private.norm_person_name(
             coalesce(sc.first_name,'') || ' ' || coalesce(sc.last_name,'')) AS nm,
           row_number() OVER (
             PARTITION BY sc.role, private.norm_person_name(
               coalesce(sc.first_name,'') || ' ' || coalesce(sc.last_name,''))
             ORDER BY sc.sort_order, sc.created_at, sc.id) - 1 AS dup
      FROM public.student_contacts sc
     WHERE sc.student_id = p_student_id
       AND sc.role IN ('authorized_pickup','do_not_release','guardian')
  ), incoming AS (
    SELECT x->>'role' AS role, x->>'nm' AS nm, (x->>'dup')::int AS dup
      FROM jsonb_array_elements(v_in) AS t(x)
  )
  DELETE FROM public.student_contacts sc
   USING existing ex
   WHERE sc.id = ex.id
     AND NOT EXISTS (
       SELECT 1 FROM incoming i
        WHERE i.role = ex.role AND i.nm = ex.nm AND i.dup = ex.dup);

  -- ---- 2. survivors updated IN PLACE, so their ids live ------------------
  -- This is the whole point of the change: no DELETE means no ON DELETE SET
  -- NULL cascade onto attendance_records, means the attendance trigger is
  -- never re-run for a contact that did not go anywhere.
  WITH existing AS (
    SELECT sc.id, sc.role,
           private.norm_person_name(
             coalesce(sc.first_name,'') || ' ' || coalesce(sc.last_name,'')) AS nm,
           row_number() OVER (
             PARTITION BY sc.role, private.norm_person_name(
               coalesce(sc.first_name,'') || ' ' || coalesce(sc.last_name,''))
             ORDER BY sc.sort_order, sc.created_at, sc.id) - 1 AS dup
      FROM public.student_contacts sc
     WHERE sc.student_id = p_student_id
       AND sc.role IN ('authorized_pickup','do_not_release','guardian')
  ), incoming AS (
    SELECT x->>'role' AS role, x->>'nm' AS nm, (x->>'dup')::int AS dup,
           x->>'first_name' AS first_name, x->>'last_name' AS last_name,
           x->>'phone' AS phone, x->>'email' AS email,
           x->>'relationship' AS relationship, x->>'notes' AS notes,
           (x->>'sort_order')::int AS sort_order
      FROM jsonb_array_elements(v_in) AS t(x)
  )
  UPDATE public.student_contacts sc
     SET first_name   = i.first_name,
         last_name    = i.last_name,
         phone        = i.phone,
         email        = i.email,
         relationship = i.relationship,
         notes        = i.notes,
         sort_order   = i.sort_order,
         updated_at   = now()
    FROM existing ex
    JOIN incoming i
      ON i.role = ex.role AND i.nm = ex.nm AND i.dup = ex.dup
   WHERE sc.id = ex.id;

  -- ---- 3. genuinely new rows only ----------------------------------------
  WITH existing AS (
    SELECT sc.role,
           private.norm_person_name(
             coalesce(sc.first_name,'') || ' ' || coalesce(sc.last_name,'')) AS nm,
           row_number() OVER (
             PARTITION BY sc.role, private.norm_person_name(
               coalesce(sc.first_name,'') || ' ' || coalesce(sc.last_name,''))
             ORDER BY sc.sort_order, sc.created_at, sc.id) - 1 AS dup
      FROM public.student_contacts sc
     WHERE sc.student_id = p_student_id
       AND sc.role IN ('authorized_pickup','do_not_release','guardian')
  ), incoming AS (
    SELECT x->>'role' AS role, x->>'nm' AS nm, (x->>'dup')::int AS dup,
           x->>'first_name' AS first_name, x->>'last_name' AS last_name,
           x->>'phone' AS phone, x->>'email' AS email,
           x->>'relationship' AS relationship, x->>'notes' AS notes,
           (x->>'sort_order')::int AS sort_order
      FROM jsonb_array_elements(v_in) AS t(x)
  )
  INSERT INTO public.student_contacts
    (student_id, organization_id, role, first_name, last_name, phone, email,
     relationship, notes, sort_order)
  SELECT p_student_id, p_organization_id, i.role, i.first_name, i.last_name,
         i.phone, i.email, i.relationship, i.notes, i.sort_order
    FROM incoming i
   WHERE NOT EXISTS (
     SELECT 1 FROM existing ex
      WHERE ex.role = i.role AND ex.nm = i.nm AND ex.dup = i.dup);

  -- ---- the student's own dismissal fields, carried over verbatim ---------
  UPDATE public.students
     SET dismissal_method   = NULLIF(p_dismissal_method, ''),
         aftercare_provider = CASE
           WHEN NULLIF(p_dismissal_method, '') = 'aftercare'
             THEN NULLIF(btrim(COALESCE(p_aftercare_provider, '')), '')
           ELSE NULL
         END
   WHERE id = p_student_id;
END;
$fn$;

comment on function public.replace_student_pickup_dnr_guardian(uuid,uuid,jsonb,jsonb,jsonb,text,text) is
  'Replace a student''s pickup / do-not-release / guardian lists and their dismissal fields, in one transaction. DIFFS rather than delete-and-reinsert: a contact still on the list is updated in place so its id survives, because attendance_records.released_to_contact_id is ON DELETE SET NULL and losing the row cascades into the attendance trigger, which then refuses the whole save (a parent hit this on 2026-09-03 and could never get past it). Row identity is (role, normalised name, duplicate rank), using the same name expression as set_attendance_records_org_and_timestamp so the two cannot disagree about who is who. A genuine removal of a guardian named on an attendance record is still refused - that check is correct. SECURITY DEFINER; EXECUTE to authenticated + service_role only.';

-- Re-assert the grants rather than trust that CREATE OR REPLACE kept them, and
-- keep anon off it. Read proacl back after applying: on this platform a
-- "revoke from public" does NOT remove anon's EXECUTE, so the only honest check
-- is the catalogue.
revoke all on function public.replace_student_pickup_dnr_guardian(uuid,uuid,jsonb,jsonb,jsonb,text,text) from public;
revoke all on function public.replace_student_pickup_dnr_guardian(uuid,uuid,jsonb,jsonb,jsonb,text,text) from anon;
grant execute on function public.replace_student_pickup_dnr_guardian(uuid,uuid,jsonb,jsonb,jsonb,text,text) to authenticated;
grant execute on function public.replace_student_pickup_dnr_guardian(uuid,uuid,jsonb,jsonb,jsonb,text,text) to service_role;
