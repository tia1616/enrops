-- Rename {{class_name}} placeholder → {{curriculum_name}} in seeded marketing
-- automation templates. The placeholder represents the curriculum name (the
-- lesson library being taught), not a generic "class". Per the locked
-- vocabulary, curriculum is the internal/admin name; class stays as natural
-- language in parent-facing copy.
--
-- Live DB has 5 rows with `{{class_name}}` in default_body and 2 in
-- default_subject. 0 customized rows in marketing_emails or marketing_automations
-- overrides (verified before this migration).
-- Run date: 2026-05-15

UPDATE marketing_automation_templates
SET default_body = REPLACE(default_body, '{{class_name}}', '{{curriculum_name}}'),
    default_subject = REPLACE(default_subject, '{{class_name}}', '{{curriculum_name}}')
WHERE default_body LIKE '%{{class_name}}%'
   OR default_subject LIKE '%{{class_name}}%';
