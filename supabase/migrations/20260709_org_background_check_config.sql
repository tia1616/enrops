-- 20260709_org_background_check_config.sql
--
-- Adds per-tenant background-check configuration to organizations so each org
-- controls whether a background check is part of instructor onboarding and,
-- until the Yardstik integration lands, how instructors are told to complete
-- one (provider name, link, instructions).
--
-- Single JSONB column so the config extends without a new migration when we
-- wire an automated provider later (add fulfillment / sub_account keys). Shape:
--   {
--     "enabled":       bool,   -- true  = required, gated onboarding step
--                              -- false = step hidden, onboarding not gated
--     "provider_name": text,   -- e.g. "Verified Volunteers" (optional)
--     "provider_url":  text,   -- link the instructor uses to start the check
--     "instructions":  text    -- free-text guidance shown in the wizard step
--   }
--
-- Default enabled=true preserves today's behavior for EVERY existing org
-- (J2S included): the background check stays a required, gated step. Provider
-- fields default empty; the wizard shows neutral copy when they're unset.
--
-- Owner/admin editable: intentionally NOT added to
-- guard_organizations_locked_columns(), so the org's own owner/admin edits it
-- via Settings -> Background checks under the existing organizations UPDATE
-- RLS. It holds no platform pricing / payout data, so it isn't locked.
--
-- Tenant-agnostic: no per-tenant seed here. Every org inherits the same
-- enabled=true default; providers customize their own copy in Settings.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS background_check_config JSONB NOT NULL
    DEFAULT '{"enabled": true}'::jsonb;

COMMENT ON COLUMN organizations.background_check_config IS
  'Per-tenant background-check onboarding config. Keys: enabled (bool; true=required gated step, false=hidden & ungated), provider_name, provider_url, instructions. Owner/admin editable via Settings -> Background checks. Extends to automated-provider (Yardstik) keys later without a new column.';
