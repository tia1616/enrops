-- Fix afterschool welcome time placement: the {{program_time}} token was
-- appended after {{location_name}} ("starts July 13 at Library, 3:25 PM"),
-- which reads as if the time modifies the location. Move it to sit right after
-- the date, matching the camp welcome ("starts July 13, 3:25 PM at Library").
-- Idempotent (LIKE-guarded REPLACE); applied to staging + prod at ship time.
UPDATE automation_templates
  SET default_body = REPLACE(
        default_body,
        'starts {{program_start_date}} at {{location_name}}{{program_time}}.',
        'starts {{program_start_date}}{{program_time}} at {{location_name}}.')
  WHERE key = 'welcome_afterschool'
    AND default_body LIKE '%starts {{program_start_date}} at {{location_name}}{{program_time}}.%';
