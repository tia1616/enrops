-- 20260603_parent_arrival_dismissal.sql
--
-- Split parent-facing vs instructor-facing location instructions.
--
-- The existing program_locations.arrival_instructions and
-- dismissal_instructions columns are overloaded — sometimes they describe
-- the parent's experience (where to drop off, what time staff escorts
-- kids), sometimes they describe the instructor's experience (door codes,
-- key locations, contact at the school). Welcome emails auto-pull these
-- into parent inboxes — leaking door codes is unacceptable.
--
-- Fix: explicit parent_* columns. The lifecycle welcome cron pulls from
-- these and these only. The original columns stay as the instructor-facing
-- source until they get their own dedicated columns or get renamed.
--
-- Backfill is intentionally NOT included here — operators have to opt in
-- per location by populating parent_arrival_instructions /
-- parent_dismissal_instructions explicitly. Until they do, the
-- {{arrival_dismissal_block}} token in welcome emails renders empty
-- (silent skip), which is the safe default.

ALTER TABLE program_locations
  ADD COLUMN IF NOT EXISTS parent_arrival_instructions text,
  ADD COLUMN IF NOT EXISTS parent_dismissal_instructions text;

COMMENT ON COLUMN program_locations.parent_arrival_instructions IS
  'Parent-safe arrival info — surfaces in welcome emails via {{arrival_dismissal_block}}. NULL means the welcome block renders empty (safe default). The original arrival_instructions column stays for instructor-facing data (door codes, keys, etc.) and is NEVER pulled into parent emails.';

COMMENT ON COLUMN program_locations.parent_dismissal_instructions IS
  'Parent-safe dismissal info. Same audience contract as parent_arrival_instructions.';
