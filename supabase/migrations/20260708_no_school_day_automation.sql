-- no_school_day automation — "No-school day heads-up" for AFTERSCHOOL programs.
--
-- Reads district_calendars.no_school_dates (already populated per district), and
-- for each upcoming closure notifies, a configurable number of days ahead:
--   • the enrolled PARENTS of every afterschool program that meets on a weekday
--     inside the closure (its class is cancelled that day), and
--   • the ASSIGNED INSTRUCTOR of that program (they're off).
--
-- This is a CALENDAR-anchored trigger, unlike every other lifecycle automation
-- (which is entity-anchored: a registration date, a birthday, a session). The
-- resolver scans the org's district calendars, groups consecutive no-school
-- dates into one "closure period" (bridging weekends so a full winter break is
-- ONE email, not one-per-day), and fires days_before the period's first day.
--
-- mailing_type = 'informational': a "your class is cancelled that day" notice is
-- a service/logistics update, not promotional — it reaches every family
-- regardless of marketing opt-out, and carries no unsubscribe footer (same as
-- welcome/recaps). Instructors likewise always get their heads-up.
--
-- Editability: the PARENT subject/body is operator-editable (subject_override /
-- body_override) like every template. Instructors receive a tailored built-in
-- default rendered by the cron. The instructor path is armed-but-silent until
-- afterschool assignments exist (program_assignments is empty out of term), so
-- no instructor email fires before scheduling runs — same "dormant until the
-- data lands" posture as birthday (waits on DOBs).
--
-- Additive + dormant: seeds one platform template row. No org gets it until an
-- operator toggles it on (creates an automations row). Idempotent — safe to
-- re-run. Apply to staging AND prod in the same pass (parity).

-- 1. Widen the trigger_type CHECK to allow the new calendar-anchored trigger.
--    Purely additive: existing values preserved, one new value added. Must list
--    every currently-allowed value (the review_request migration added
--    'days_after_engagement'; keep it here).
ALTER TABLE public.automation_templates
  DROP CONSTRAINT IF EXISTS automation_templates_trigger_type_check;

ALTER TABLE public.automation_templates
  ADD CONSTRAINT automation_templates_trigger_type_check
  CHECK (trigger_type = ANY (ARRAY[
    'event_registration_confirmed',
    'days_before_first_session',
    'days_after_first_session',
    'session_midpoint',
    'session_last_day',
    'birthday',
    'event_registration_abandoned',
    'survey_pending',
    'contact_added',
    'contact_dormant',
    'days_after_engagement',
    'days_before_no_school'
  ]));

-- 2. Seed the no_school_day template. Idempotent on the UNIQUE(key).
--    Copy avoids em dashes per the tenant-email house style. Reason token
--    always resolves to something readable (falls back to "a no-school day"),
--    so "for {{no_school_reason}}" never renders awkwardly.
INSERT INTO public.automation_templates (
  key, display_name, description,
  trigger_type, applies_to_program_type, mailing_type,
  default_subject, default_body, default_timing,
  time_saved_minutes_per_send, push_to_parent_portal, is_v1_enabled, sort_order
) VALUES (
  'no_school_day',
  'No-school day heads-up',
  'Remind families (and the instructor) before a no-school day, so nobody shows up to a cancelled class. Dates come from your district calendars. Sent a set number of days ahead, and it groups a multi-day break into one message.',
  'days_before_no_school',
  'afterschool',
  'informational',
  'Heads up: no {{program_name}} on {{no_school_dates}}',
  '<p style="margin:0 0 16px;">Hi there,</p>
<p style="margin:0 0 16px;">Quick heads up: {{location_name}} has no school on {{no_school_dates}}, so {{program_name}} will not meet then.</p>
<p style="margin:0 0 16px;">Class picks back up as usual the following week. If anything changes, we will let you know.</p>
<p style="margin:0 0 16px;">Questions? Just reply to this email.</p>
<p style="margin:0;">See you soon,<br>{{sender_name}}</p>',
  '{"days_before": 7}'::jsonb,
  3,
  true,
  true,
  115
)
ON CONFLICT (key) DO NOTHING;
