-- Adds a 'welcome' variant to platform_announcements.
--
-- Why a variant rather than a show_ennie column: Ennie belongs to a TONE, not to
-- an arbitrary flag. A warning banner with a smiling character on it is wrong in
-- every case, so a boolean that permits that combination is modelling something
-- we never want. "welcome" names the warm, first-run treatment, and the frontend
-- renders Ennie for exactly that.
--
-- Additive and inert, in both directions:
--   - it only WIDENS the allowed set, so no existing row can violate it;
--   - a database that has this but an older frontend still renders fine, because
--     AnnouncementBanner falls back to the info palette for an unknown variant;
--   - a frontend that knows 'welcome' but meets an un-migrated database simply
--     never sees the value, because no row can be written with it.
-- So the order the two land in does not matter, which is what makes it safe to
-- apply to both environments in the same pass.

alter table public.platform_announcements
  drop constraint if exists platform_announcements_variant_check;

alter table public.platform_announcements
  add constraint platform_announcements_variant_check
  check (variant = any (array['info'::text, 'success'::text, 'warning'::text, 'welcome'::text]));
