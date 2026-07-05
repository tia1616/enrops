-- Additive: capture a contact's child birthdate so contact-based automations
-- (the birthday automation, once extended to fire off marketing_recipients) can
-- use it. Populated by the PDF/CSV importer when the source doc carries a DOB
-- (e.g. a single-student signup export); null otherwise. Applied to staging via
-- MCP 2026-07-04; prod at release.
alter table public.marketing_recipients
  add column if not exists child_birthdate date;
