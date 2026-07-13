-- Rework the Welcome {{program_time}} token from an inline comma-prefixed clause
-- into a clean, reusable token wrapped in parentheses.
--
-- Before: the token resolved to ", 9:00 AM - 12:00 PM" and the body read
--   "...starts {{program_start_date}}{{program_time}}." so the comma lived
--   inside the token. That made {{program_time}} awkward to reuse standalone in
--   other automations (it carried a leading comma). Now the cron's timeClause
--   returns a CLEAN range ("9:00 AM - 12:00 PM"), so {{program_time}} can be
--   dropped into any template. The welcome copy wraps it in parens:
--   "...starts {{program_start_date}} ({{program_time}})." When the time is
--   unknown the token is "" and the cron's renderTokens strips the bare " ()".
--
-- Ships in lockstep with the lifecycle-automations-cron change (clean timeClause
-- + empty-paren tidy). Apply this migration and deploy that function together,
-- or a body with " ({{program_time}})" would briefly render "(, 9:00 AM ...)".
--
-- Generic across tenants (pattern-matched, not org-scoped) and idempotent:
-- each UPDATE is LIKE-guarded on the pre-change substring, so re-running once
-- the parens are present is a no-op. Applied to staging + prod at ship time.

-- Camp welcome (template default_body):
--   "starts {{program_start_date}}{{program_time}}." ->
--   "starts {{program_start_date}} ({{program_time}})."
UPDATE automation_templates
  SET default_body = REPLACE(default_body,
        'starts {{program_start_date}}{{program_time}}.',
        'starts {{program_start_date}} ({{program_time}}).')
  WHERE key = 'welcome_camp'
    AND default_body LIKE '%starts {{program_start_date}}{{program_time}}.%';

-- Afterschool welcome (template default_body):
--   "starts {{program_start_date}}{{program_time}} at {{location_name}}." ->
--   "starts {{program_start_date}} ({{program_time}}) at {{location_name}}."
UPDATE automation_templates
  SET default_body = REPLACE(default_body,
        'starts {{program_start_date}}{{program_time}} at {{location_name}}.',
        'starts {{program_start_date}} ({{program_time}}) at {{location_name}}.')
  WHERE key = 'welcome_afterschool'
    AND default_body LIKE '%starts {{program_start_date}}{{program_time}} at {{location_name}}.%';

-- Any tenant camp-welcome body_override (e.g. J2S) gets the same rewrap.
UPDATE automations a
  SET body_override = REPLACE(a.body_override,
        'starts {{program_start_date}}{{program_time}}.',
        'starts {{program_start_date}} ({{program_time}}).')
  FROM automation_templates t
  WHERE a.template_id = t.id
    AND t.key = 'welcome_camp'
    AND a.body_override LIKE '%starts {{program_start_date}}{{program_time}}.%';

-- Any tenant afterschool-welcome body_override gets the same rewrap.
UPDATE automations a
  SET body_override = REPLACE(a.body_override,
        'starts {{program_start_date}}{{program_time}} at {{location_name}}.',
        'starts {{program_start_date}} ({{program_time}}) at {{location_name}}.')
  FROM automation_templates t
  WHERE a.template_id = t.id
    AND t.key = 'welcome_afterschool'
    AND a.body_override LIKE '%starts {{program_start_date}}{{program_time}} at {{location_name}}.%';
