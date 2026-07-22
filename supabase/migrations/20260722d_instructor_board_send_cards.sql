-- Comms reorg: surface the operator-initiated instructor sends (availability
-- survey, class offers, sub/cover requests) in the Automations list as
-- INFORMATIONAL cards — the transparency principle (the list is the one place
-- that shows everything Enrops helps you send), WITHOUT changing how they send:
-- the operator still triggers them from the Schedule board. These cards have no
-- on/off toggle (a manual send has no enable state — a toggle would be a dead
-- control); the frontend renders them with a "Send from your Schedule" link.
--
-- trigger_type 'operator_initiated' = fired by the operator from a surface, not
-- by cron. The cron NEVER processes these (no org ever gets an `automations` row
-- for them, because there is no toggle to create one), so no cron change is
-- needed; the switch's default already skips any unknown trigger safely.
--
-- Ships DARK (is_v1_enabled=false) so they don't appear until the whole Comms
-- branch ships to prod and Jessica flips go-live. Staging flips them true for
-- review. audiences=['instructors']. Additive + inert; parity both envs.

-- Extend the trigger_type allowlist with the new operator_initiated value.
alter table public.automation_templates
  drop constraint if exists automation_templates_trigger_type_check;
alter table public.automation_templates
  add constraint automation_templates_trigger_type_check
  check (trigger_type = any (array[
    'event_registration_confirmed','days_before_first_session','days_after_first_session',
    'session_midpoint','session_last_day','birthday','event_registration_abandoned',
    'survey_pending','contact_added','contact_dormant','days_after_engagement',
    'days_before_no_school','instructor_birthday','operator_initiated'
  ]));

insert into public.automation_templates
  (key, display_name, description, trigger_type, applies_to_program_type, mailing_type,
   default_subject, default_body, default_timing, time_saved_minutes_per_send,
   push_to_parent_portal, is_v1_enabled, sort_order, audience, audiences, lifecycle_stage)
values
  ('availability_survey', 'Availability survey',
   'Ask your instructors which classes they can take for the season. You send this from your Schedule board.',
   'operator_initiated', 'all', 'informational',
   'Availability survey', '<p>Sent from your Schedule board.</p>', '{}'::jsonb,
   15, false, false, 130, 'instructors', array['instructors']::text[], 'getting_started'),
  ('assignment_offer', 'Class offers',
   'Offer classes to your instructors and track who accepts. You send these from your Schedule board.',
   'operator_initiated', 'all', 'informational',
   'Class offers', '<p>Sent from your Schedule board.</p>', '{}'::jsonb,
   15, false, false, 131, 'instructors', array['instructors']::text[], 'getting_started'),
  ('sub_offer', 'Sub & cover requests',
   'Ask instructors to cover a class when someone cannot make it. You send these from your Schedule board.',
   'operator_initiated', 'all', 'informational',
   'Sub & cover requests', '<p>Sent from your Schedule board.</p>', '{}'::jsonb,
   10, false, false, 132, 'instructors', array['instructors']::text[], 'during')
on conflict (key) do update set
  display_name = excluded.display_name, description = excluded.description,
  trigger_type = excluded.trigger_type, applies_to_program_type = excluded.applies_to_program_type,
  mailing_type = excluded.mailing_type, default_subject = excluded.default_subject,
  default_body = excluded.default_body, default_timing = excluded.default_timing,
  time_saved_minutes_per_send = excluded.time_saved_minutes_per_send,
  push_to_parent_portal = excluded.push_to_parent_portal, sort_order = excluded.sort_order,
  audience = excluded.audience, audiences = excluded.audiences, lifecycle_stage = excluded.lifecycle_stage;
