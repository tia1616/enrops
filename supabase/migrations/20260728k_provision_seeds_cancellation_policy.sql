-- Wire seed_default_cancellation_policy() into tenant provisioning, right after
-- the existing seed_default_waivers() call, so a new operator has a cancellation
-- policy to show at checkout from the moment they open (v4 section 6).
--
-- WHY THIS PATCHES RATHER THAN REDEFINES. provision_operator_org() is shared
-- ground and other work lands in it; re-emitting a full body from a migration
-- file would silently revert whatever else had been added since this was
-- written. So it reads the LIVE definition, inserts one line after a known
-- anchor, and re-executes. It is idempotent (no-ops if already wired) and it
-- REFUSES to guess if the anchor has moved, rather than producing a function
-- body nobody intended.

DO $mig$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc WHERE oid = 'public.provision_operator_org(text,text)'::regprocedure;

  IF position('seed_default_cancellation_policy' IN v_def) > 0 THEN
    RAISE NOTICE 'already wired; nothing to do';
    RETURN;
  END IF;

  v_new := replace(
    v_def,
    'PERFORM public.seed_default_waivers(v_org);',
    'PERFORM public.seed_default_waivers(v_org);' || chr(10) ||
    '  -- v4 section 6: a tenant must have a cancellation policy to show at' || chr(10) ||
    '  -- checkout from day one. Same platform-template pattern as the waivers' || chr(10) ||
    '  -- above; never overwrites one the operator has already written.' || chr(10) ||
    '  PERFORM public.seed_default_cancellation_policy(v_org);'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'anchor line not found - provisioning function changed shape, refusing to guess';
  END IF;

  EXECUTE v_new;
  RAISE NOTICE 'wired cancellation seed into provisioning';
END $mig$;
