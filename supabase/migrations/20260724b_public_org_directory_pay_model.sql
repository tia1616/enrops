-- Expose instructor_pay_model on the public org directory so the family-facing
-- pages (registration, login) can render a lean, enrops-branded experience for
-- self-serve operators instead of J2S's hardcoded curriculum/district page.
--
-- Additive + inert: CREATE OR REPLACE appends one column at the end; no existing
-- column, order, or grant changes. instructor_pay_model is a non-sensitive enum
-- ('enrops_platform' | 'legacy_own_platform'), safe to expose to anon. Nothing
-- reads it until the front-end ships. Applied to staging + prod in the same pass.

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
    'enabled', COALESCE((background_check_config ->> 'enabled')::boolean, true),
    'provider_name', background_check_config ->> 'provider_name',
    'provider_url', background_check_config ->> 'provider_url',
    'instructions', background_check_config ->> 'instructions'
  ) AS background_check_public,
  COALESCE((training_config ->> 'enabled')::boolean, false) AS training_enabled,
  instructor_pay_model
FROM organizations
WHERE status = 'active';
