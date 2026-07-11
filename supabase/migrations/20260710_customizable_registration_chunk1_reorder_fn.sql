-- Customizable Registration — Chunk 1: atomic reorder RPC for custom questions.
-- Spec: docs/specs/customizable-registration.md
--
-- The Settings builder reorders a provider's CUSTOM registration questions with
-- ↑/↓. Doing that as two separate UPDATEs (swap A<->B) is non-atomic: a partial
-- failure leaves two rows sharing a sort_order and the ordering ambiguous. This
-- RPC rewrites the whole ordered set of custom rows in one transaction.
--
-- Custom questions live in a sort_order band starting at 101 so they always sort
-- AFTER the standard questions (which use 0..99 by catalog position). Only
-- standard_key IS NULL rows are touched — standard questions keep their order.
--
-- SECURITY DEFINER (bypasses RLS) so the body is the only gate: it authorizes
-- the caller as an org editor. Locked to authenticated (parents/anon never call).
--
-- Applied to staging (mumfymlapolsfdnpewci) first, then prod
-- (iuasfpztkmrtagivlhtj) in the SAME pass (parity).

CREATE OR REPLACE FUNCTION public.reorder_registration_fields(
  p_org_id uuid,
  p_ordered_ids uuid[]
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  i int;
BEGIN
  IF NOT (can_edit_org(p_org_id) OR is_platform_admin()) THEN
    RAISE EXCEPTION 'not authorized to reorder questions for organization %', p_org_id;
  END IF;

  IF p_ordered_ids IS NULL THEN RETURN; END IF;

  FOR i IN 1 .. array_length(p_ordered_ids, 1) LOOP
    UPDATE public.custom_reg_fields
       SET sort_order = 100 + i
     WHERE id = p_ordered_ids[i]
       AND organization_id = p_org_id
       AND standard_key IS NULL;   -- only reorder custom questions
  END LOOP;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reorder_registration_fields(uuid, uuid[]) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.reorder_registration_fields(uuid, uuid[]) TO authenticated;
