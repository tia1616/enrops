-- Defense-in-depth: two self-gating SECURITY DEFINER fns already reject anon
-- in-body, but anon shouldn't be able to call them at all. Matches the twin
-- replace_student_contacts / sub_roster_program_ids pattern. Revoke the default
-- PUBLIC grant (which is how anon inherits EXECUTE) and re-grant only the roles
-- that call these: authenticated (user JWT) + service_role (edge fns).
--
-- Neither was exploitable (both raise 'not authorized' for anon in-body); this is
-- advisor hygiene + matching our own established grant pattern.
--
-- Applied to staging (mumfymlapolsfdnpewci) then prod (iuasfpztkmrtagivlhtj) in the
-- SAME pass (parity). Verified has_function_privilege('anon', ...) = false on both.

REVOKE EXECUTE ON FUNCTION public.replace_student_pickup_dnr_guardian(uuid, uuid, jsonb, jsonb, jsonb, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.replace_student_pickup_dnr_guardian(uuid, uuid, jsonb, jsonb, jsonb, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.apply_term_early_bird(uuid, text, text, numeric, date) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.apply_term_early_bird(uuid, text, text, numeric, date) TO authenticated, service_role;
