-- public_org_directory: publish each business's year-bundle setting to the
-- registration page.
--
-- WHY. create-registration now refuses a year bundle unless the business has
-- bundles switched on, at its own price, for a school it has not excluded
-- (organizations.vip_offering). The registration page (portal/Home.jsx and
-- Register.jsx) OFFERS bundles from data shape alone - fall + winter + spring at
-- the same school and weekday - because it could not read vip_offering: this
-- view did not carry it. So the page could offer a full-year option the server
-- then refused, after the family had filled in the whole form. Live trigger:
-- The Ukulele Project (bundles off) has an open FA26 class whose WI27 and SP27
-- twins are drafts; publishing them while its page is on FA26 would do it.
--
-- WHAT. One new column, appended LAST, so every existing column keeps its name,
-- type and position and no current reader changes:
--   vip_offering_public = { enabled, price_cents, excluded_location_ids }
-- Only those three keys. label/description are marketing copy nobody on this
-- page reads yet; leave them out until something does.
-- `enabled` compares the JSON value to true rather than casting text, so a
-- malformed value reads as OFF (fail closed: no bundle offered) instead of
-- erroring every public page.
--
-- NOTHING PRIVATE. A business's bundle on/off, its bundle price, and which of
-- its schools are excluded are all things the registration page shows or acts
-- on in public. Same posture as 20260914a: no security_invoker (reloptions null),
-- table-level SELECT to anon and authenticated, so no new GRANT is needed.
--
-- ONE TEXT FOR BOTH ENVIRONMENTS. CREATE OR REPLACE VIEW can only append
-- columns, never reorder or drop, so this must follow class_photos_enabled
-- (20261009b_class_photos.sql). Class photos shipped to prod first (main
-- 0fd40da3, 2026-10-12) and prod's view was verified live to end
-- `... support_email, class_photos_enabled`, the same as staging - so this file
-- applies to prod exactly as written.
--
-- DO NOT ALIAS `organizations` - see 20260914a; instructorDocuments.test.mjs
-- regex-reads the newest redefinition of this view.
begin;

create or replace view public.public_org_directory as
  select
    id,
    slug,
    name,
    organizations.logo_url,
    logo_email_url,
    status,
    timezone,
    active_registration_term,
    jsonb_build_object(
      'enabled', coalesce((background_check_config ->> 'enabled')::boolean, true),
      'provider_name', background_check_config ->> 'provider_name',
      'provider_url', background_check_config ->> 'provider_url',
      'instructions', background_check_config ->> 'instructions'
    ) as background_check_public,
    coalesce((training_config ->> 'enabled')::boolean, false) as training_enabled,
    instructor_pay_model,
    coalesce(stripe_charges_enabled, false) as stripe_charges_enabled,
    jsonb_build_object(
      'contractor_status', coalesce((instructor_document_config -> 'contractor_status') <> 'false'::jsonb, true),
      'contractor_agreement', true,
      'pay_schedule', coalesce((instructor_document_config -> 'pay_schedule') <> 'false'::jsonb, true),
      'attendance_policy', coalesce((instructor_document_config -> 'attendance_policy') <> 'false'::jsonb, true),
      'code_of_conduct', coalesce((instructor_document_config -> 'code_of_conduct') <> 'false'::jsonb, true),
      'mandatory_reporter_ack', coalesce((instructor_document_config -> 'mandatory_reporter_ack') <> 'false'::jsonb, true),
      'photo_video_release', coalesce((instructor_document_config -> 'photo_video_release') <> 'false'::jsonb, true),
      'vehicle_driving_ack', coalesce((instructor_document_config -> 'vehicle_driving_ack') <> 'false'::jsonb, true)
    ) as instructor_documents_public,
    coalesce(instructor_pay_enabled, false) as instructor_pay_enabled,
    coalesce(
      nullif(btrim(b.email_reply_to), ''),
      nullif(btrim(email), '')
    ) as support_email,
    coalesce(class_photos_enabled, false) as class_photos_enabled,
    -- NEW. The year-bundle setting, three keys only. See the header.
    jsonb_build_object(
      'enabled', coalesce((vip_offering -> 'enabled') = 'true'::jsonb, false),
      'price_cents', vip_offering -> 'price_cents',
      'excluded_location_ids', coalesce(vip_offering -> 'excluded_location_ids', '[]'::jsonb)
    ) as vip_offering_public
  from public.organizations
  left join public.org_branding b on b.organization_id = organizations.id
  where status = 'active';

commit;
