-- Per-document on/off for instructor onboarding documents.
--
-- WHY. All seven documents are mandatory for every provider today, because the
-- one provider who had any needed all seven. A chess tutor whose instructors
-- never drive is forced to write a driving acknowledgment before anybody can
-- finish onboarding.
--
-- ABSENT MEANS ON. The config starts '{}' and an absent key resolves to ON, so
-- every existing org keeps all seven and there is no backfill. Only an explicit
-- `false` turns a document off.
--
-- THE TRAP THIS AVOIDS: "off" is never inferred from "not published". A provider
-- who intends to have a code of conduct but has not written it yet keeps it ON,
-- so onboarding still waits for it rather than quietly passing instructors who
-- never acknowledged one. Absence of a document is not a decision; only the
-- toggle is.
--
-- contractor_agreement is NOT toggleable. It is the one document that is signed
-- rather than acknowledged, submit-agreement requires it, and onboarding cannot
-- complete without it. The view below pins it to true so no config value can
-- disagree with the client, which enforces the same rule.

alter table public.organizations
  add column if not exists instructor_document_config jsonb not null default '{}'::jsonb;

comment on column public.organizations.instructor_document_config is
  'Per-document on/off for instructor onboarding documents, keyed by legal_documents.document_key. An ABSENT key means ON; only an explicit false turns a document off, so a document that has simply not been written yet still blocks onboarding. contractor_agreement is always on and is ignored here. Instructor-facing copy is exposed via public_org_directory.instructor_documents_public.';

-- Object-only. Nothing writes anything else, but an array or a bare string here
-- would make every `->` lookup below return null and silently turn everything
-- back on across the whole org.
alter table public.organizations
  drop constraint if exists organizations_instructor_document_config_is_object;
alter table public.organizations
  add constraint organizations_instructor_document_config_is_object
  check (jsonb_typeof(instructor_document_config) = 'object');

-- Expose the resolved set to the instructor.
--
-- The wizard runs as the instructor, who is not an org_member and therefore
-- cannot read `organizations` at all — which is exactly why
-- background_check_public and training_enabled already live on this view. The
-- document config has to arrive the same way.
--
-- Compared as JSONB (`-> key <> 'false'`) rather than cast with `::boolean`.
-- A cast throws on any non-boolean value, and this view is read by anonymous
-- visitors on public pages: one malformed value written through the API would
-- take the whole view down for everyone. The jsonb comparison cannot throw, and
-- anything that is not exactly `false` resolves to ON — the safe side, since ON
-- means "onboarding still asks for it".
--
-- Column APPENDED at the end: create or replace view can add columns only at the
-- end, and doing so preserves the existing grants (anon/authenticated SELECT).
create or replace view public.public_org_directory as
  select
    id,
    slug,
    name,
    logo_url,
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
      -- Always on. Pinned to a literal so a stray config value cannot disagree
      -- with the client, which hard-codes the same rule.
      'contractor_agreement', true,
      'pay_schedule',         coalesce(instructor_document_config -> 'pay_schedule'         <> 'false'::jsonb, true),
      'attendance_policy',    coalesce(instructor_document_config -> 'attendance_policy'    <> 'false'::jsonb, true),
      'code_of_conduct',      coalesce(instructor_document_config -> 'code_of_conduct'      <> 'false'::jsonb, true),
      'mandatory_reporter_ack', coalesce(instructor_document_config -> 'mandatory_reporter_ack' <> 'false'::jsonb, true),
      'photo_video_release',  coalesce(instructor_document_config -> 'photo_video_release'  <> 'false'::jsonb, true),
      'vehicle_driving_ack',  coalesce(instructor_document_config -> 'vehicle_driving_ack'  <> 'false'::jsonb, true)
    ) as instructor_documents_public
  from organizations
  where status = 'active';
