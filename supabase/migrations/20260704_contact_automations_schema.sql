-- Contact-based automations (welcome_contact, reengagement) fire off
-- marketing_recipients (ALL contacts, not just families enrolled through
-- Enrops). Additive schema only:
--   - two new trigger types (contact_added, contact_dormant)
--   - an 'all' applies-to value (contact automations aren't program-typed)
--   - a per-contact suppress_welcome flag, set by the "existing families —
--     skip the welcome" import choice, so importing an existing roster never
--     triggers a welcome blast.
-- All three are supersets of the current values; nothing in the tables
-- violates them. Applied to staging via MCP 2026-07-04; prod at release.

-- 1. per-contact welcome suppression (set by the "existing families" import choice)
alter table public.marketing_recipients
  add column if not exists suppress_welcome boolean not null default false;

-- 2. trigger_type — add contact_added, contact_dormant (superset of existing 8)
alter table public.automation_templates
  drop constraint if exists automation_templates_trigger_type_check;
alter table public.automation_templates
  add constraint automation_templates_trigger_type_check
  check (trigger_type = any (array[
    'event_registration_confirmed','days_before_first_session','days_after_first_session',
    'session_midpoint','session_last_day','birthday','event_registration_abandoned',
    'survey_pending','contact_added','contact_dormant'
  ]));

-- 3. applies_to_program_type — add 'all' (contact automations aren't program-typed)
alter table public.automation_templates
  drop constraint if exists automation_templates_applies_to_check;
alter table public.automation_templates
  add constraint automation_templates_applies_to_check
  check (applies_to_program_type = any (array['camps','afterschool','both','all']));
