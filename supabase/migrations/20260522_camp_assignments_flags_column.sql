-- Persist matcher per-assignment flags so the admin scheduling UI can surface
-- the "why" behind a distance bonus. Currently flags live in matcher memory
-- and disappear once a proposed assignment is published.
--
-- Known flag values (from match-instructors/lib.ts OutputFlag type):
--   location_override   - assigned to a location they marked unavailable (carries $50 bonus)
--   location_low_pref   - assigned to a not_preferred location
--   curriculum_mismatch - assigned to a curriculum they marked not_preferred
--
-- Backfill strategy: leave existing rows with the default empty array. They
-- predate the flag persistence; admin sees the existing distance_bonus_cents
-- on the row with no contextual pill until those assignments roll off
-- (end of SU26).
--
-- Applied 2026-05-22 (executed live against project iuasfpztkmrtagivlhtj).

ALTER TABLE public.camp_assignments
  ADD COLUMN flags TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.camp_assignments.flags IS
  'Matcher-produced flags persisted at publish time. Values: location_override, location_low_pref, curriculum_mismatch. Empty array means no special-case flags. See match-instructors/lib.ts OutputFlag type for the canonical list.';
