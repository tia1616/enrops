-- Add touchpoint_id to marketing_sends so dedup can be per-touchpoint.
--
-- Before this migration: dedup key was (campaign_id, recipient_id). A multi-
-- touchpoint campaign (e.g. announce + 24h reminder) sent touchpoint 1, then
-- touchpoint 2 got skipped for every recipient as "already sent."
--
-- After: dedup key is (campaign_id, touchpoint_id, recipient_id). Each
-- touchpoint sends to each recipient exactly once.
--
-- Legacy rows (the J2S FA26-launch sends from earlier this term) have
-- touchpoint_id NULL. The new dedup query checks both campaign_id AND
-- touchpoint_id equality, so legacy "campaign-as-one-blast" sends don't
-- collide with new touchpoint-by-touchpoint sends.

ALTER TABLE marketing_sends
  ADD COLUMN IF NOT EXISTS touchpoint_id uuid
    REFERENCES marketing_campaign_touchpoints(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS marketing_sends_dedup_per_touchpoint_idx
  ON marketing_sends (campaign_id, touchpoint_id, recipient_id);

COMMENT ON COLUMN marketing_sends.touchpoint_id IS
  'Which touchpoint within the campaign this send corresponds to. NULL for legacy J2S FA26-launch sends (predates touchpoints). The dedup query in marketing-touchpoint-send keys on (campaign_id, touchpoint_id, recipient_id) so each touchpoint fires exactly once per recipient.';
