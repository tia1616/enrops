-- Remove the platform-seeded "Program fit" waiver (Jessica, 2026-07-28: "delete").
--
-- WHICH ONE. There are TWO similarly-named waivers and only one of them is ours:
--
--   "Program fit"                 - the platform-seeded default. Ours.
--   "Program Fit Acknowledgment"  - J2S's OWN long-standing waiver, ACTIVE on
--                                   prod with 91 signatures against it.
--
-- Deleting by name would be a coin flip between them, so rows are matched on the
-- platform template's exact CONTENT instead. Verified before writing: content
-- matching selects 6 rows on prod (the template + 5 tenants) and 10 on staging,
-- and picks up J2S's waiver on neither.
--
-- DELETE, NOT DEACTIVATE - WHERE THAT IS SAFE. A waiver row is what a signature
-- points at, so a signed waiver can never be deleted: waiver_signatures_waiver_id_fkey
-- is ON DELETE NO ACTION, which means Postgres REFUSES rather than cascading.
-- That is the behaviour we want and this migration works with it rather than
-- around it:
--
--   0 signatures  -> DELETE (prod: all 5 tenants + the template)
--   >0 signatures -> active = false, so it leaves the registration form but the
--                    signature still resolves to the thing that was signed
--                    (staging only: onboard-test 8, riverbend 2)
--
-- The self-reference waivers.replaced_by was checked too - zero referencing rows
-- in both environments - because a delete that ignored it would fail the same way.

DO $mig$
DECLARE
  v_platform   uuid;
  v_tpl        text;
  v_deactivated int;
  v_deleted     int;
BEGIN
  SELECT id INTO v_platform FROM public.organizations WHERE slug = 'enrops';
  IF v_platform IS NULL THEN
    RAISE EXCEPTION 'no enrops platform org - refusing to guess which waiver is ours';
  END IF;

  SELECT content INTO v_tpl
  FROM public.waivers
  WHERE organization_id = v_platform AND name = 'Program fit';

  IF v_tpl IS NULL THEN
    RAISE NOTICE 'no platform "Program fit" template - already removed, nothing to do';
    RETURN;
  END IF;

  -- Signed copies: retire rather than remove. Named explicitly so a tenant who
  -- renamed their copy is still covered - content is the identity here, not name.
  UPDATE public.waivers w
     SET active = false, updated_at = now()
   WHERE w.content = v_tpl
     AND w.active
     AND EXISTS (SELECT 1 FROM public.waiver_signatures s WHERE s.waiver_id = w.id);
  GET DIAGNOSTICS v_deactivated = ROW_COUNT;

  -- Unsigned copies, including the platform template itself, so no tenant
  -- provisioned from here on ever receives it again.
  DELETE FROM public.waivers w
   WHERE w.content = v_tpl
     AND NOT EXISTS (SELECT 1 FROM public.waiver_signatures s WHERE s.waiver_id = w.id)
     AND NOT EXISTS (SELECT 1 FROM public.waivers x WHERE x.replaced_by = w.id);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RAISE NOTICE 'Program fit: deleted %, deactivated % (signed)', v_deleted, v_deactivated;
END $mig$;
