-- Drop the wave-1/2 marketing tables that are no longer wired to any code.
-- All callers were removed in the 2026-05-19 marketing function cleanup
-- (marketing-send-email, marketing-automations-cron, marketing-render-preview,
-- marketing-render-and-send, MarketingAdmin.jsx, src/pages/admin/marketing/).
-- Don + marketing_campaign_touchpoints is the model going forward.
--
-- Row counts at time of drop:
--   marketing_emails: 0
--   marketing_plans: 0
--   marketing_groups: 0
--   marketing_automations: 6 (J2S lifecycle config — superseded by Don)
--   marketing_automation_templates: 6 (seed templates — superseded by Don)
--
-- Drop order respects the marketing_emails.plan_id -> marketing_plans.id FK.
-- No CASCADE: if anything unexpected depends on these, fail loudly.

DROP TABLE IF EXISTS marketing_emails;
DROP TABLE IF EXISTS marketing_plans;
DROP TABLE IF EXISTS marketing_groups;
DROP TABLE IF EXISTS marketing_automations;
DROP TABLE IF EXISTS marketing_automation_templates;
