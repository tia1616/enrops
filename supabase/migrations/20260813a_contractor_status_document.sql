-- The independent-contractor-status document: optional, and OFF by default.
--
-- WHAT THIS IS FOR. Screen 4's tick box read "I confirm my status as an
-- independent contractor under ORS 670.600" — an Oregon statute, shown to
-- instructors in every state, on a box they had to tick to be onboarded. The
-- recorded plan was a per-state onboarding step. Jessica cancelled that on
-- 2026-08-13 ("we're not going to track all state policies"): fifty states'
-- classification tests, each amendable, is a compliance product we are not
-- building and could not keep correct, and a stale citation reads authoritative
-- while being wrong.
--
-- So the provider states it. This adds a document they can write, in which they
-- link to their OWN state's page, and which their instructors acknowledge on
-- Screen 6 with the text rendered directly above the checkbox. Strictly more
-- evidence than a statute number in a label, and correct in fifty states.
--
-- WHY IT DEFAULTS OFF, when every other document defaults ON.
--
-- The "absent means ON" rule exists so that a document a provider MEANT to have
-- but has not written yet keeps blocking onboarding, rather than being silently
-- treated as unused. Absence is not a decision.
--
-- That argument does not reach this key. Nobody has ever been offered it, so an
-- absent value means "never offered", not "not yet written" — there is no
-- provider intent to protect. And defaulting it on would take every existing
-- provider and every instructor mid-onboarding and block them on a document that
-- does not exist and that nobody has been asked to write: an outage wearing a
-- safety argument. Nothing is lost by it being off, because the contractor
-- agreement is signed regardless, is never toggleable, and already covers
-- contractor status in its own body. This is an additional, per-state
-- acknowledgment on top.
--
-- Expressed as `= 'true'` rather than `<> 'false'`, which is the inverse of
-- every other key here and is the entire behavioural difference. Strict equality
-- against the jsonb literal, so a hand-written 1 or "yes" in the JSONB cannot
-- switch on a legal acknowledgment nobody chose in the UI. Matches
-- isDocumentEnabled in src/lib/instructorDocuments.js and its server mirror in
-- supabase/functions/_shared/instructorDocumentConfig.ts.
--
-- MIGRATION BEFORE FRONTEND, as always: the wizard reads
-- instructor_documents_public and PostgREST rejects an entire select naming an
-- absent column, so shipping the other way round puts every instructor
-- mid-onboarding on an error screen. This one is additive to a jsonb object
-- rather than a new column, so it is the milder case — but the rule is the rule.
--
-- Existing rows need no backfill. Every provider's instructor_document_config
-- stays exactly as it is; the absent key now resolves to false instead of not
-- being present at all.

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
    -- Pinned true. The agreement is SIGNED rather than acknowledged,
    -- submit-agreement requires it, and onboarding cannot complete without it,
    -- so no stored config value is allowed to disagree with it.
    'contractor_agreement', true,
    'pay_schedule',
      coalesce((instructor_document_config -> 'pay_schedule') <> 'false'::jsonb, true),
    'attendance_policy',
      coalesce((instructor_document_config -> 'attendance_policy') <> 'false'::jsonb, true),
    'code_of_conduct',
      coalesce((instructor_document_config -> 'code_of_conduct') <> 'false'::jsonb, true),
    -- OPT-IN. The one key that needs an explicit true; see the header.
    'contractor_status',
      coalesce((instructor_document_config -> 'contractor_status') = 'true'::jsonb, false),
    'mandatory_reporter_ack',
      coalesce((instructor_document_config -> 'mandatory_reporter_ack') <> 'false'::jsonb, true),
    'photo_video_release',
      coalesce((instructor_document_config -> 'photo_video_release') <> 'false'::jsonb, true),
    'vehicle_driving_ack',
      coalesce((instructor_document_config -> 'vehicle_driving_ack') <> 'false'::jsonb, true)
  ) as instructor_documents_public,
  coalesce(instructor_pay_enabled, false) as instructor_pay_enabled
from organizations
where status = 'active';

-- create or replace view drops grants in some paths; reassert them. The wizard
-- reads this view before an instructor has a session (anon) and after (authenticated).
grant select on public.public_org_directory to anon, authenticated;

-- The column comment still stated the old rule as absolute. It is what `\d+
-- organizations` and the Supabase table editor surface, so it is the first thing
-- the next person reads about this column — and it would have told them absence
-- always means ON, which is now wrong for exactly one key and wrong in the
-- dangerous direction (they would "fix" the opt-in back to default-on and hand
-- every provider's instructors an unpublished document).
comment on column public.organizations.instructor_document_config is
  'Per-document on/off for instructor onboarding documents, keyed by legal_documents.document_key. An ABSENT key means ON — only an explicit false turns a document off, so a document that has simply not been written yet still blocks onboarding. ONE EXCEPTION: contractor_status is opt-in and needs an explicit true; it is new, optional, and defaulting it on would block every existing provider''s instructors on a document nobody was asked to write. contractor_agreement is always on and is ignored here. Instructor-facing copy is exposed via public_org_directory.instructor_documents_public, which resolves every key to a boolean — that view must list every key in src/lib/instructorDocuments.js or the missing one reads as ON.';
