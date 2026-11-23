-- 20261123e: public_org_directory exposes classes_follow_dates (20261123d), so
-- the family page and the instructor portal can apply the one "which seasons are
-- on sale" rule (src/lib/classSeasons.js).
--
-- The body below is 20261012a's text unchanged, with ONE column appended at the
-- end (CREATE OR REPLACE VIEW can only append). Before writing it, the live view
-- was read on both environments: pg_get_viewdef md5 48e4e9e68dafbf9ffe7d5ef185ecefe8
-- on staging AND prod (2026-11-23), reloptions NULL on both (no security_invoker
-- to lose). Grants on a replaced view are kept; read back after applying.
--
-- DO NOT ALIAS `organizations` - see 20260914a; instructorDocuments.test.mjs
-- regex-reads the newest redefinition of this view.
--
-- DEPLOY ORDER: this must reach an environment BEFORE the frontend that selects
-- classes_follow_dates from the view. PostgREST fails the whole read on an
-- unknown column, and that read is the family catalog.
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
    jsonb_build_object(
      'enabled', coalesce((vip_offering -> 'enabled') = 'true'::jsonb, false),
      'price_cents', vip_offering -> 'price_cents',
      'excluded_location_ids', coalesce(vip_offering -> 'excluded_location_ids', '[]'::jsonb)
    ) as vip_offering_public,
    -- NEW (20261123d): whether this provider's classes follow their dates.
    classes_follow_dates
  from public.organizations
  left join public.org_branding b on b.organization_id = organizations.id
  where status = 'active';

commit;
