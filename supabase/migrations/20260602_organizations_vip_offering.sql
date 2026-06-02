-- Single source of truth for an org's VIP / annual-pass offering. Replaces:
--   1. programs.vip_price_cents per-row (now an optional override, mostly unused)
--   2. marketing_campaigns.draft_inputs.promo.vip_option per-campaign bool
--      (stays as "should THIS campaign mention it" toggle)
--   3. Hardcoded "STEAM VIP" mentions in the marketing-draft-campaign edge fn
--      (was J2S-specific brand language baked into a multi-tenant function)
--
-- Ennie reads this column to decide whether/how to talk about an annual pass.
-- Per-recipient: if recipient's school is in excluded_location_ids, the VIP
-- block is suppressed for that recipient at send time (marketing-touchpoint-send
-- handles the {{vip_block}} token resolution).
--
-- Shape:
--   {
--     "enabled":               bool,    -- master toggle
--     "label":                 text,    -- e.g. "STEAM VIP", "Annual Pass"
--     "price_cents":           int,     -- the year price
--     "description":           text,    -- 1-sentence pitch for emails
--     "excluded_location_ids": uuid[]   -- schools where VIP isn't offered
--   }
alter table organizations
  add column if not exists vip_offering jsonb not null default '{"enabled": false}'::jsonb;

comment on column organizations.vip_offering is
  'Single source of truth for tenant''s VIP/annual-pass offering. Read by Ennie''s draft pass + token resolver. Shape: {enabled, label, price_cents, description, excluded_location_ids[]}';
