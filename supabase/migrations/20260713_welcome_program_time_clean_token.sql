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
--   unknown the token is "" and the cron's renderTokens collapses the wrapper.
--
-- Ships in lockstep with the lifecycle-automations-cron change (clean timeClause
-- + wrapper collapse). Apply this migration and deploy that function together,
-- or a body with the bare adjacency renders the date and time run together
-- ("...June 179:00 AM...") once the comma is gone.
--
-- Matched on the token ADJACENCY "{{program_start_date}}{{program_time}}" rather
-- than on full fixed sentences, so it rewraps EVERY body that carries the pair
-- regardless of a tenant's surrounding wording (the previous exact-sentence form
-- would have missed a customized override and left it run-together). One REPLACE
-- covers both the camp ("...{{program_time}}.") and afterschool
-- ("...{{program_time}} at {{location_name}}.") shapes.
--
-- Idempotent: after the rewrite the pair reads "{{program_start_date}} ({{program_time}})",
-- so the LIKE guard (which looks for the bare adjacency) no longer matches and a
-- second run is a no-op. Generic across tenants. Applied to staging + prod at
-- ship time.

-- Template defaults (welcome_camp + welcome_afterschool default_body).
UPDATE automation_templates
  SET default_body = REPLACE(default_body,
        '{{program_start_date}}{{program_time}}',
        '{{program_start_date}} ({{program_time}})')
  WHERE default_body LIKE '%{{program_start_date}}{{program_time}}%';

-- Any tenant welcome body_override (e.g. J2S's customized camp welcome).
UPDATE automations
  SET body_override = REPLACE(body_override,
        '{{program_start_date}}{{program_time}}',
        '{{program_start_date}} ({{program_time}})')
  WHERE body_override LIKE '%{{program_start_date}}{{program_time}}%';
