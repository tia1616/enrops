-- Chunk 4a step 1 (Comms reorg): instructor birthday automation.
--
-- The automations engine is generic — a new automation is a catalog row
-- (automation_templates) + a per-trigger resolver in lifecycle-automations-cron.
-- birthday exists for FAMILIES; this adds the instructor-audience sibling. New
-- trigger_type 'instructor_birthday' so the cron routes it to the instructor
-- resolver (reads instructors.date_of_birth) instead of the family/student one.
--
-- Ships DARK: is_v1_enabled=false so it does NOT appear in any org's Automations
-- menu on apply. Staging flips it true for review/testing; prod stays dark until
-- the whole Comms branch ships and the cron carrying the resolver is deployed
-- there (a toggle with no resolver behind it would be a dead control). No org has
-- an `automations` row for it, so even enabled it can't fire without the cron.
-- Additive + inert; parity = applied to staging AND prod the same pass.

-- trigger_type is CHECK-constrained to a fixed allowlist. Extend it (additively)
-- with the new instructor_birthday trigger, or the insert below fails 23514.
alter table public.automation_templates
  drop constraint if exists automation_templates_trigger_type_check;
alter table public.automation_templates
  add constraint automation_templates_trigger_type_check
  check (trigger_type = any (array[
    'event_registration_confirmed','days_before_first_session','days_after_first_session',
    'session_midpoint','session_last_day','birthday','event_registration_abandoned',
    'survey_pending','contact_added','contact_dormant','days_after_engagement',
    'days_before_no_school','instructor_birthday'
  ]));

insert into public.automation_templates
  (key, display_name, description, trigger_type, applies_to_program_type,
   mailing_type, default_subject, default_body, default_timing,
   time_saved_minutes_per_send, push_to_parent_portal, is_v1_enabled, sort_order)
values (
  'instructor_birthday',
  'Instructor birthday',
  'Wish each active instructor a happy birthday on their birthday.',
  'instructor_birthday',
  'all',
  'informational',
  'Happy birthday, {{first_name}}!',
  -- {{org_name}} sits mid-sentence on purpose: an org whose name ends in "." (e.g.
  -- "Cascade Enrichment Co.") would otherwise render a double period ("Co..").
  '<p style="margin:0 0 16px;">Hi {{first_name}},</p>' ||
  '<p style="margin:0 0 16px;">Everyone at {{org_name}} wishes you a very happy birthday! We are so glad to have you on the team, and we hope your day is full of good things.</p>' ||
  '<p style="margin:0;">Cheers,<br>{{sender_name}}</p>',
  '{}'::jsonb,
  2,
  false,
  false,
  120
)
on conflict (key) do update set
  -- Refresh the platform-catalog copy on re-apply, but never touch is_v1_enabled
  -- (that's the per-env go-live switch — clobbering it would un-dark staging or
  -- prematurely light prod).
  display_name = excluded.display_name,
  description = excluded.description,
  trigger_type = excluded.trigger_type,
  applies_to_program_type = excluded.applies_to_program_type,
  mailing_type = excluded.mailing_type,
  default_subject = excluded.default_subject,
  default_body = excluded.default_body,
  default_timing = excluded.default_timing,
  time_saved_minutes_per_send = excluded.time_saved_minutes_per_send,
  push_to_parent_portal = excluded.push_to_parent_portal,
  sort_order = excluded.sort_order;
