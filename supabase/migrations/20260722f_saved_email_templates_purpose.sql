-- Instructor board sends (availability survey, assignment offer, sub/cover
-- offer) seed their editable copy from a matching instructor template on the
-- shared shelf. `purpose` tags WHICH board send a template feeds so the board
-- can look up the org's default copy for that send.
--
-- NULL = a general template with no board-send binding. EVERY existing row
-- (all family campaign copy + any instructor/partner templates saved so far)
-- gets NULL, so behavior is byte-unchanged. Additive + inert.
--
-- purpose is only meaningful for audience='instructors' templates today; the
-- Templates UI only offers it there. Kept as a plain column (not coupled to
-- audience in the CHECK) so a future audience can reuse the mechanism without
-- a constraint rewrite.
alter table public.saved_email_templates
  add column if not exists purpose text;

alter table public.saved_email_templates
  drop constraint if exists saved_email_templates_purpose_check;

alter table public.saved_email_templates
  add constraint saved_email_templates_purpose_check
  check (purpose is null or purpose = any (array[
    'availability_survey', 'assignment_offer', 'sub_offer'
  ]));
