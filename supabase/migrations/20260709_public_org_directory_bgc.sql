-- 20260709_public_org_directory_bgc.sql
--
-- Expose the instructor-facing background-check config through the public org
-- directory view so the onboarding wizard can read it. Instructors are not
-- org_members, so they can't SELECT the organizations row directly (the only
-- SELECT policy is members_read_own_org). The wizard already reads slug from
-- this view; add a background_check_public column alongside it.
--
-- IMPORTANT: expose ONLY the four instructor-facing keys, not the whole
-- background_check_config blob. This view is readable by anon, and future
-- automated-provider work may add internal keys (e.g. a Yardstik sub_account
-- id) to background_check_config — those must never leak here. Whitelisting
-- keys keeps this view safe as the config grows.

CREATE OR REPLACE VIEW public.public_org_directory AS
SELECT
  id,
  slug,
  name,
  logo_url,
  logo_email_url,
  status,
  timezone,
  active_registration_term,
  jsonb_build_object(
    'enabled',       COALESCE((background_check_config->>'enabled')::boolean, true),
    'provider_name', background_check_config->>'provider_name',
    'provider_url',  background_check_config->>'provider_url',
    'instructions',  background_check_config->>'instructions'
  ) AS background_check_public
FROM organizations
WHERE status = 'active'::text;
