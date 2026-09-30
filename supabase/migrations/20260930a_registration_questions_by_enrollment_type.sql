-- A registration question can be asked of after-school families, camp families,
-- or everyone — and the choice is CONFIGURATION, not a rule buried in code.
--
-- WHY THIS EXISTS. Homeroom teacher is required, and a camp has no classroom to
-- collect a child from, so being asked it stopped a camp registration dead.
-- Register.jsx therefore drops homeroom when every item in a child's cart is a
-- camp (Jessica, 2026-09-28: "drop homeroom for camps"). That works, but it is a
-- rule only the code knows: the next question with the same shape — a what-to-
-- bring note for a full-day camp, a school-specific waiver — needs another code
-- change, and the operator screen cannot show what is really asked.
--
-- custom_reg_fields.applies_to has ALWAYS allowed 'enrollment_type' (the CHECK
-- lists 'all', 'enrollment_type', 'program'), and applies_to_value is there to
-- hold which one. Somebody designed exactly this. What was missing is that THIS
-- function dropped those rows on the floor: its WHERE matched 'all' or 'program'
-- and nothing else, so an 'enrollment_type' row was returned to nobody and the
-- question was asked of nobody. A half-built mechanism that fails silently.
--
-- WHY THE FUNCTION RETURNS THEM RATHER THAN FILTERING THEM.
-- It would be natural to filter here, against p_program_id. That would be WORSE
-- than what exists, for two reasons:
--   1. p_program_id is whatever ?program= carried when the page loaded. A family
--      browsing the catalogue arrives with none, and then it is NULL.
--   2. A child's cart can hold several classes. "Is this a camp?" is a question
--      about the CART, not about one program — which is exactly why the existing
--      homeroom rule is written over activeChild.items, and why it is correct.
-- So the database returns what is CONFIGURED and the form, which is the only
-- place that knows the cart, decides what to ASK. The readers that call this
-- without a cart (the parent dashboard, the pickup gate, the instructor portal,
-- the roster) keep receiving every row exactly as they do today.
--
-- INERT ON ARRIVAL: zero rows carry applies_to = 'enrollment_type' on either
-- database, so this returns precisely what it returned before until a question
-- is deliberately scoped.
--
-- CREATE OR REPLACE, not DROP + CREATE: it keeps the existing EXECUTE grants
-- (postgres, anon, authenticated, service_role). anon MUST keep it — guest
-- checkout reads this with no session — and a DROP would silently revoke them.
-- The grants are read back after applying.

create or replace function public.get_active_registration_fields(
  p_org_id uuid,
  p_program_id uuid default null
)
returns setof custom_reg_fields
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select * from public.custom_reg_fields
  where organization_id = p_org_id
    and is_active = true
    and (
      applies_to = 'all'
      or (
        p_program_id is not null
        and applies_to = 'program'
        and applies_to_value = p_program_id::text
      )
      -- Returned, not resolved. applies_to_value carries 'afterschool' or 'camp';
      -- the caller that knows the cart applies it. See the note above.
      or applies_to = 'enrollment_type'
    )
  order by sort_order, created_at;
$function$;

comment on function public.get_active_registration_fields(uuid, uuid) is
  'Active registration questions for an org: org-wide, plus this program''s own, '
  'plus every enrollment_type-scoped question. enrollment_type rows are RETURNED '
  'UNRESOLVED - applies_to_value is ''afterschool'' or ''camp'' and only the '
  'registration form knows the child''s cart, so the form filters them. Readers '
  'without a cart receive them all, unchanged from before.';
