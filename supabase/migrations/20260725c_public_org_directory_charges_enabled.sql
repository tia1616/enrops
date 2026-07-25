-- Expose payment-readiness on the PUBLIC org view so a provider's registration
-- page can refuse to list classes until they can actually be paid. Without it
-- the catalog happily advertises programs whose checkout is blocked, which is a
-- worse experience than saying "not open yet" -- a family fills in a whole form
-- and only then discovers they can't pay.
--
-- Additive: appended as the LAST column, so every existing consumer is
-- unaffected. Not sensitive -- a yes/no about whether the provider is open for
-- business, which is exactly what a visitor is entitled to know.
--
-- Applied to STAGING and PROD in the same pass (schema parity). Inert on prod
-- until the frontend that reads it ships, and J2S is stripe_charges_enabled=true
-- so its catalog is unchanged either way.
create or replace view public.public_org_directory as
 SELECT id,
    slug,
    name,
    logo_url,
    logo_email_url,
    status,
    timezone,
    active_registration_term,
    jsonb_build_object('enabled', COALESCE((background_check_config ->> 'enabled'::text)::boolean, true), 'provider_name', background_check_config ->> 'provider_name'::text, 'provider_url', background_check_config ->> 'provider_url'::text, 'instructions', background_check_config ->> 'instructions'::text) AS background_check_public,
    COALESCE((training_config ->> 'enabled'::text)::boolean, false) AS training_enabled,
    instructor_pay_model,
    COALESCE(stripe_charges_enabled, false) AS stripe_charges_enabled
   FROM organizations
  WHERE status = 'active'::text;
