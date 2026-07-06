-- Add the {{program_time}} token to the Welcome emails so parents see the
-- session time, not just the date. Pairs with the lifecycle-automations-cron
-- change that resolves the time from the session's DB row.
--
-- Idempotent: each UPDATE is guarded by a LIKE on the pre-change pattern and
-- REPLACE only rewrites that exact substring, so re-running is a no-op once the
-- token is present. Applied to staging + prod at ship time.

-- Camp welcome (template default_body): "...starts {{program_start_date}}." →
-- "...starts {{program_start_date}}{{program_time}}."
UPDATE automation_templates
  SET default_body = REPLACE(default_body, 'starts {{program_start_date}}.', 'starts {{program_start_date}}{{program_time}}.')
  WHERE key = 'welcome_camp'
    AND default_body LIKE '%starts {{program_start_date}}.%';

-- Afterschool welcome (template default_body): "...at {{location_name}}." →
-- "...at {{location_name}}{{program_time}}."
UPDATE automation_templates
  SET default_body = REPLACE(default_body, 'at {{location_name}}.', 'at {{location_name}}{{program_time}}.')
  WHERE key = 'welcome_afterschool'
    AND default_body LIKE '%at {{location_name}}.%';

-- Any tenant camp-welcome body_override (e.g. J2S) gets the same token so a
-- customized welcome shows the time too.
UPDATE automations a
  SET body_override = REPLACE(a.body_override, 'starts {{program_start_date}}.', 'starts {{program_start_date}}{{program_time}}.')
  FROM automation_templates t
  WHERE a.template_id = t.id
    AND t.key = 'welcome_camp'
    AND a.body_override LIKE '%starts {{program_start_date}}.%';
