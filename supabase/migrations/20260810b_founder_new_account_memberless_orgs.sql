-- 20260810b_founder_new_account_memberless_orgs.sql
--
-- Review fix on 20260810a.
--
-- That migration seeded a `new_account` suppression row for EVERY organization
-- that existed, on the reasoning that no existing org is news. True for an org
-- somebody has already joined. Not true for an org with no members yet: nobody
-- has created an account there, so the milestone has not happened, and
-- suppressing it means the day that person finally signs up produces silence -
-- permanently, because the suppression row is what UNIQUE collides with.
--
-- That is exactly the case Jessica creates by hand: provision an org for a
-- prospect now, the prospect joins next week. The one signup worth hearing
-- about would have been the one that never arrived.
--
-- Verified before writing this: PROD has zero memberless organizations right
-- now, and 20260810a has not been applied there at all, so nothing is currently
-- suppressed in error on either environment. This is a latent bug being closed
-- ahead of the prod apply, not damage being repaired.
--
-- Runs AFTER 20260810a on prod (a seeds every org, b removes the ones that were
-- not eligible), and corrects staging where a has already run. Idempotent:
-- re-running deletes nothing new.
delete from public.founder_notifications fn
where fn.trigger_key = 'new_account'
  and fn.backfilled
  -- Never touch a row that actually notified somebody. backfilled rows are
  -- suppression-only and sent_at is null by construction, but deleting a real
  -- send record would re-arm an email that has already gone out.
  and fn.sent_at is null
  and fn.dispatched_at is null
  and not exists (
    select 1 from public.org_members m
     where m.organization_id = fn.organization_id
  );
