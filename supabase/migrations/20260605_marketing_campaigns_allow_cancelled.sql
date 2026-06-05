-- Allow a campaign to be cancelled.
--
-- Before this, marketing_campaigns.status only permitted
--   draft | ready | sending | sent | paused
-- so there was no terminal "operator killed this campaign" state — and the UI
-- had no way to stop an approved (status='sending') campaign short of pausing
-- it. The Campaigns list now exposes a Cancel action that sets the campaign to
-- 'cancelled' and flips its still-queued touchpoints to 'cancelled' too. The
-- touchpoints table already allowed 'cancelled'; this brings the campaign table
-- in line.
--
-- The send cron only fires touchpoints whose parent campaign is status='sending'
-- AND whose own status is 'queued', so a 'cancelled' campaign (or cancelled
-- touchpoints) is invisible to it — no further sends. Cancelling does NOT unsend
-- anything already delivered; it only stops future touchpoints.

ALTER TABLE marketing_campaigns
  DROP CONSTRAINT IF EXISTS marketing_campaigns_status_check;

ALTER TABLE marketing_campaigns
  ADD CONSTRAINT marketing_campaigns_status_check
  CHECK (status = ANY (ARRAY['draft','ready','sending','sent','paused','cancelled']));
