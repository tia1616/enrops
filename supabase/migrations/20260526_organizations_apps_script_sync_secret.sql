-- Per-tenant secret used by an Apps Script in the tenant's Google account
-- to authenticate inbound roster sync calls to the edge function
-- apps-script-roster-sync. UNIQUE so the function can resolve the org
-- from the secret alone (no separate org_id param needed).
--
-- Generate with: encode(gen_random_bytes(32), 'hex'). Tenant pastes this
-- into their Apps Script properties as ROSTER_SYNC_SECRET.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS apps_script_sync_secret TEXT UNIQUE;

COMMENT ON COLUMN organizations.apps_script_sync_secret IS 'Per-tenant opaque secret. Apps Script in tenant Google account presents this to apps-script-roster-sync edge function to authenticate inbound sync calls. NULL = no Apps Script integration configured.';
