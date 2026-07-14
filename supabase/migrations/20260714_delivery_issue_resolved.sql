-- "Mark handled" + resend audit for the Didn't-send surface.
--
-- Lets an operator dismiss a failed lifecycle send they've dealt with out of band
-- (fixed the address, contacted the family directly). The row STAYS
-- status='failed' for the audit trail; resolved_at just removes it from the
-- "needs you" surfaces (panel, homescreen card, and the delivery-alert email).
-- Additive + inert until the delivery-issue-action edge fn + panel buttons ship.
--
--   resolved_at - when an operator marked this failed send handled (NULL = open).
--   resolved_by - the auth user id who marked it (audit trail).

ALTER TABLE public.automation_run_recipients
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by uuid;
