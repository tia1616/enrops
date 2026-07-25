-- Per-program registration fields (checklist: "Only ask for fields the specific
-- program actually needs — don't force full-season fields onto a one-day workshop").
--
-- The table ALREADY supports scoping (applies_to CHECK allows 'all' |
-- 'enrollment_type' | 'program', with applies_to_value holding the target), but
-- the reader ignored it and returned every active row to every program.
--
-- New optional p_program_id:
--   NULL  -> org-wide fields only ('all'). Used by the surfaces that render a
--            family's saved answers without a program in hand (parent dashboard,
--            instructor portal, pickup gate).
--   given -> org-wide fields PLUS the ones scoped to that program.
--
-- 'enrollment_type' rows are deliberately NOT returned: nothing passes an
-- enrollment type, so we'd be guessing. There are zero such rows today.
--
-- BACKWARD COMPATIBLE: every existing caller passes only p_org_id and every
-- existing row is applies_to='all', so today's behavior is byte-identical. The
-- 1-arg version is dropped in the same transaction so a 1-arg call can't become
-- ambiguous between two overloads.
drop function if exists public.get_active_registration_fields(uuid);

create or replace function public.get_active_registration_fields(
  p_org_id uuid,
  p_program_id uuid default null
)
 returns setof custom_reg_fields
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  SELECT * FROM public.custom_reg_fields
  WHERE organization_id = p_org_id
    AND is_active = true
    AND (
      applies_to = 'all'
      OR (
        p_program_id IS NOT NULL
        AND applies_to = 'program'
        AND applies_to_value = p_program_id::text
      )
    )
  ORDER BY sort_order, created_at;
$function$;
