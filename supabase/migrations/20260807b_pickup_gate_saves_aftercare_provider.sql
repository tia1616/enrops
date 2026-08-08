-- replace_student_pickup_dnr_guardian gains p_aftercare_provider.
--
-- WHY. PickupInfoGate is the second place a family answers "how does your child
-- leave" - it exists for children who registered before those questions did. It
-- renders the SAME PickupDismissalSection the registration form does, so the
-- moment a provider offers `aftercare` the gate offers it too. But the gate's save
-- goes through this RPC, which had nowhere to put the provider's name.
--
-- Left alone, a parent completing the gate would pick "Goes to aftercare", see the
-- "Which aftercare program?" box, type into it, and lose the answer with no error.
-- The roster would then read "Aftercare (provider not stated)" forever, on the
-- custody path, for a parent who did answer.
--
-- SIGNATURE CHANGE WITH NO BROKEN WINDOW. Adding a parameter creates a NEW
-- function rather than replacing the old one, so both exist for a while and the
-- order matters in BOTH directions:
--
--   - Drop the 6-arg version here, and PRODUCTION BREAKS THE INSTANT THIS RUNS.
--     The deployed frontend still calls 6 arguments; it would get PGRST202 and the
--     pickup gate would fail for every parent until Netlify finished building.
--     "Migrations ship before the frontend" is the usual rule and it is WRONG for
--     this change - the failing side is the migration, not the frontend.
--   - Add the parameter WITH a default, and a 6-arg call becomes ambiguous:
--     Postgres has two candidates and raises "function is not unique". Also broken.
--
-- So: NO DEFAULT, and the old signature stays. Arity alone then resolves the call -
-- 6 arguments can only mean the old function, 7 can only mean this one - and both
-- work simultaneously. Old frontend keeps working, new frontend uses the new path,
-- and neither environment has a moment where the gate is down.
--
-- The 6-arg version is dropped in a SEPARATE later migration, once both
-- environments are serving a frontend that passes 7. Left behind deliberately
-- rather than forgotten: see the note at the bottom of this file.
--
-- Body is otherwise IDENTICAL to the deployed 6-arg version, read back from
-- pg_get_functiondef rather than reconstructed from memory, so the authorization
-- checks, the delete-all-roles-first ordering that avoids tripping the pickup/DNR
-- exclusion trigger, and the three insert loops are unchanged.

create or replace function public.replace_student_pickup_dnr_guardian(
  p_student_id uuid,
  p_organization_id uuid,
  p_pickup jsonb,
  p_do_not_release jsonb,
  p_guardian jsonb,
  p_dismissal_method text,
  -- NO DEFAULT, deliberately. A default here would make the existing 6-argument
  -- call ambiguous against the old signature and break every caller that has not
  -- been updated yet. See the header.
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

-- The 6-argument version is INTENTIONALLY NOT DROPPED HERE. Dropping it now would
-- break the currently-deployed frontend on both environments. It stays until a
-- frontend passing 7 arguments is live on staging AND prod, then goes in its own
-- migration. Tracked at the bottom of this file so it is a deferred step rather
-- than an orphan nobody remembers.

-- Re-grant on the new signature. Grants do NOT carry across to a new function,
-- and losing EXECUTE here would break the gate for every parent.
--
-- Both roles, read off the deployed 6-arg function rather than assumed: it had
-- EXECUTE for `authenticated` AND `service_role` (plus postgres as owner).
-- Granting only `authenticated` would have quietly removed service_role's access
-- and broken whatever backend path relies on it - a grant nobody notices missing
-- until something server-side fails.
--
-- NOTE: this leaves the function reachable by `anon`, which 20260807c then
-- revokes. The two are separate files ON PURPOSE - that is exactly the order they
-- were applied to staging, and splitting them keeps the repo, staging's
-- schema_migrations and prod's telling the same story. Squashing them into one
-- file would have made the audit trail disagree with reality on the one table
-- someone reads when diagnosing an environment difference.
revoke all on function public.replace_student_pickup_dnr_guardian(
  uuid, uuid, jsonb, jsonb, jsonb, text, text
) from public;
grant execute on function public.replace_student_pickup_dnr_guardian(
  uuid, uuid, jsonb, jsonb, jsonb, text, text
) to authenticated;
grant execute on function public.replace_student_pickup_dnr_guardian(
  uuid, uuid, jsonb, jsonb, jsonb, text, text
) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- DEFERRED, ON PURPOSE: drop the 6-argument signature.
--
-- Safe to run once a frontend that passes 7 arguments is live on BOTH staging and
-- production - not before, or the deployed frontend loses its save. Confirm with:
--
--   select pg_get_function_identity_arguments(p.oid)
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname = 'replace_student_pickup_dnr_guardian';
--
-- Two rows until it is done. Then:
--
--   drop function if exists public.replace_student_pickup_dnr_guardian(
--     uuid, uuid, jsonb, jsonb, jsonb, text
--   );
--
-- Until that runs, a 6-argument call silently keeps writing the OLD behaviour -
-- dismissal saved, aftercare provider ignored. That is the correct trade during
-- the rollout window and a bug if it is left there, so it is written down rather
-- than remembered.
-- ─────────────────────────────────────────────────────────────────────────────
