-- Comms reorg Step 2 (partner roster automation) — FOUNDATION.
--
-- Adds the partner_roster automation to the catalog so it appears under
-- Comms>Automations>Partners. Ships is_v1_enabled=FALSE on BOTH envs = "Coming
-- soon" (disabled toggle) until the sending engine lands — a live toggle with no
-- cron behind it would be a dead control (honest-state / control-audit rule).
--
-- Design (Jessica): afterschool ONLY, only classes WE run registration for
-- (programs.runs_own_registration=false + organizations.uses_enrops_registration),
-- to the partner site's partner_contacts. TWO fires per program: 7 days before
-- first_session_date (snapshot) + the morning of the first session (final). The
-- engine will REUSE email-program-roster (PDF + send) via a system-auth invoke,
-- not rebuild the PDF in-cron. default_subject/body here are placeholders (the
-- real email is built by email-program-roster) but the columns are NOT NULL.

alter table public.automation_templates
  drop constraint if exists automation_templates_trigger_type_check;
alter table public.automation_templates
  add constraint automation_templates_trigger_type_check
  check (trigger_type = any (array[
    'event_registration_confirmed','days_before_first_session','days_after_first_session',
    'session_midpoint','session_last_day','birthday','event_registration_abandoned',
    'survey_pending','contact_added','contact_dormant','days_after_engagement',
    'days_before_no_school','instructor_birthday','operator_initiated','partner_roster'
  ]));

insert into public.automation_templates
  (key, display_name, description, trigger_type, applies_to_program_type, mailing_type,
   default_subject, default_body, default_timing, time_saved_minutes_per_send,
   push_to_parent_portal, is_v1_enabled, sort_order, audience, audiences, lifecycle_stage)
values (
  'partner_roster', 'Class roster to partner',
  'Email each partner site the roster for their afterschool class — a week before it starts, and again the morning of the first day. Only for classes you run registration for.',
  'partner_roster', 'afterschool', 'informational',
  'Class roster', '<p>The class roster is attached.</p>', '{"days_before": 7}'::jsonb,
  10, false, false, 140, 'partners', array['partners']::text[], 'getting_started')
on conflict (key) do update set
  display_name = excluded.display_name, description = excluded.description,
  trigger_type = excluded.trigger_type, applies_to_program_type = excluded.applies_to_program_type,
  mailing_type = excluded.mailing_type, default_subject = excluded.default_subject,
  default_body = excluded.default_body, default_timing = excluded.default_timing,
  time_saved_minutes_per_send = excluded.time_saved_minutes_per_send,
  push_to_parent_portal = excluded.push_to_parent_portal, sort_order = excluded.sort_order,
  audience = excluded.audience, audiences = excluded.audiences, lifecycle_stage = excluded.lifecycle_stage;
