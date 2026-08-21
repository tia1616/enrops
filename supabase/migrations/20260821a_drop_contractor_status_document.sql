-- 20260821a_drop_contractor_status_document.sql
--
-- Remove the `contractor_status` ("Independent contractor status") instructor
-- document. Jessica, 2026-08-21: "we don't need contractor doc and independent
-- contractor status doc. they are redundant."
--
-- WHY IT IS SAFE TO DELETE RATHER THAN HIDE. Counted on both databases first:
--   PROD    : 0 documents written, 0 orgs with the config key, 0 acknowledgements.
--   STAGING : 1 document + 1 config key, both on the Cascade demo tenant, a
--             fixture written by me for testing.
-- No provider was ever asked for one, so there is no operator intent to preserve
-- and no acknowledgement history to strand.
--
-- WHY IT EXISTED AND WHY THAT REASON IS GONE. It was built as the replacement for
-- Screen 4's "under ORS 670.600" citation, under a planned per-state attestation
-- step. Jessica cancelled that step on 2026-08-13 ("we're not going to track all
-- state policies"). With no per-state plan there is nothing for this document to
-- carry: contractor status is already asserted by the tick box an instructor ticks
-- and by the contractor agreement they sign, which for J2S states the statute in
-- its own body.
--
-- WHAT THE REMOVAL BUYS. It was the ONLY document that defaulted OFF, so the whole
-- "absent means ON, EXCEPT this key" asymmetry existed for it alone - in the view
-- below, in src/lib/instructorDocuments.js and in
-- supabase/functions/_shared/instructorDocumentConfig.ts. All three now say the
-- same single sentence.
--
-- NARROWING AUDIT (gate 0b) - this view is what the WIZARD reads, because an
-- instructor cannot read `organizations` at all.
--   BEFORE : 8 keys - contractor_agreement, pay_schedule, attendance_policy,
--            code_of_conduct, contractor_status, mandatory_reporter_ack,
--            photo_video_release, vehicle_driving_ack
--   AFTER  : the same 7, minus contractor_status
--   LOST   : the resolved boolean for contractor_status. Intended: no screen
--            offers it any more, and a key the JS does not know is exactly what
--            the original header warned about in the other direction.
-- The dangerous direction is a key present in the JS and MISSING from this view,
-- because the wizard then reads undefined and treats it as ON. Both sides are
-- changed in this same pass, so that state never exists.
--
-- The `contractor_status` KEY IS LEFT IN ANY EXISTING instructor_document_config
-- JSONB rather than stripped. It is inert once nothing reads it, and rewriting a
-- provider's config column to remove a dead key is a bigger, riskier write than
-- the problem deserves.
--
-- NOT TOUCHED, and easy to confuse with this: `contractor_agreements
-- .confirm_contractor_status`, the boolean an instructor ticks when signing. That
-- is a different thing with 24 signed rows on prod, and it stays exactly as it is.

-- FORMATTED TO MATCH 20260813a CHARACTER-FOR-CHARACTER, minus the deleted key.
-- The first draft of this file was pasted from pg_get_viewdef, which prints
-- capitalised keywords, `::text` casts on the jsonb arrows and an extra paren pair
-- around each COALESCE argument. Semantically identical, textually different - and
-- src/lib/instructorDocuments.test.mjs parses this file to pin every key's
-- resolution, so the variation failed six assertions for no reason. Keep this
-- lowercase, one key per two lines, so a future diff against the sibling shows
-- only what actually changed.
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
      -- `contractor_status` STOOD HERE, resolved with `= 'true'` because it was the
      -- one opt-in document. It is deleted, and with it the only exception to the
      -- rule that every key below follows: absent means ON.
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
