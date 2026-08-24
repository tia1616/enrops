-- 20260821e_contractor_status_document_restored.sql
--
-- THIS REVERTS 20260821a. Read that file first; it is not wrong about the law and
-- its reasoning is worth keeping, it was just wrong about the product. Rather than
-- leave two migrations that disagree with no explanation, here is the whole story:
--
--   20260813a  added `contractor_status` as an OPT-IN document (`= 'true'`), the
--              only one that defaulted off, built for a planned per-state
--              attestation step.
--   20260821a  deleted the key, because that per-state step was cancelled on
--              2026-08-13 and contractor status is already asserted by the tick box
--              and by the contractor agreement. True, and it missed the point.
--   20260821e  (this file) puts the key back as an ORDINARY, DEFAULT-ON document.
--
-- WHY. There is a whole SCREEN in the wizard explaining independent-contractor
-- status to instructors (Screen3ORS) - hardcoded, backed by nothing, invisible in
-- Settings. Jeff Kerestes walked his own onboarding as an instructor on 2026-08-21,
-- liked that screen, and could not find it anywhere in Settings to edit it. Jessica:
-- "the ideas in this and the box agreeing that they're independent contractors must
-- remain. Need to add this as editable on one of the screens... but he has to know
-- it's there, seen in settings." So the screen stays and becomes the provider's
-- document. Deleting the key would have left the screen exactly as invisible as it
-- was; this makes it a thing a provider owns.
--
-- NOT THE SAME DOCUMENT AS BEFORE, in the one way that matters here: it resolves
-- with `<> 'false'` (ABSENT MEANS ON) like every other key, not with `= 'true'`.
-- 20260813a's opt-in shape was the ONLY exception to that rule in this view, and it
-- is not coming back - the document now backs a screen every instructor already
-- sees, so ON is the state that matches what is already happening. "Absent means
-- ON" is once again one sentence with no exceptions.
--
-- COUNTED LIVE ON BOTH DATABASES BEFORE WRITING THIS, so "additive and inert" is
-- measured rather than assumed:
--   PROD    : 0 rows in legal_documents with document_key = 'contractor_status',
--             0 organizations whose instructor_document_config holds the key.
--   STAGING : the same, 0 and 0. (20260821a's notes describe one Cascade fixture
--             document; that row is gone.)
-- Both databases were also byte-identical to 20260821a's definition before this ran
-- (same md5 of pg_get_viewdef), so this file is the only thing that moves them.
--
-- THE ZERO COUNTS ARE WHAT MAKES THE KEY SAFE, NOT WHAT MAKES THE MIGRATION SAFE.
-- Nothing here inherits an OFF a provider never chose, which is a real property. It
-- says nothing about whether the deployed frontend on a given environment reads the
-- key - see the sequencing note below, which is where the first draft of this file
-- went wrong.
--
-- WIDENING, not narrowing (gate 0b). This view is what the WIZARD reads, because an
-- instructor cannot select from `organizations` at all.
--   BEFORE : 7 keys - contractor_agreement, pay_schedule, attendance_policy,
--            code_of_conduct, mandatory_reporter_ack, photo_video_release,
--            vehicle_driving_ack
--   AFTER  : those same 7, plus contractor_status
--   LOST   : nothing. No column, no key, no row filter changes. The column list of
--            the view is unchanged; one key is added inside one jsonb payload.
--
-- APPLIED TO STAGING ONLY. DO NOT APPLY TO PROD AHEAD OF THE FRONTEND.
--
-- The first draft of this header said the opposite - "safe to apply ahead of the
-- frontend, prod's frontend does not know this key" - and that was WRONG. It reasoned
-- about staging's frontend and called it prod's. Read `origin/main`, which is what
-- enrops.com actually serves:
--   * src/lib/instructorDocuments.js on main STILL defines `contractor_status` and
--     still carries `defaultOff: true`, so its isDocumentEnabled resolves the key as
--     `config?.[key] === true`, not `!== false`.
--   * src/pages/onboarding/screens/Screen6Additional.jsx on main still lists
--     CONTRACTOR_STATUS_KEY in ALL_DOC_KEYS.
-- So on prod this view is READ, with opt-in semantics. Applying this file there
-- flips the key from undefined (=> off) to true (=> ON) for every organization at
-- once; Screen 6 would then fetch a document that has ZERO published rows anywhere
-- on prod; and that screen's 404 branch sets a screen-wide loadError and returns
-- BEFORE rendering the form. Every instructor reaching Screen 6 on prod would see
-- "Your program hasn't published these documents yet" instead of the three real
-- documents, with no way to finish onboarding. A prod outage, from an "inert"
-- migration.
--
-- WHICH SIDE BREAKS ALONE - the real answer, per environment:
--   STAGING, DB first : safe, and done. staging's frontend deleted the key outright
--                       (20260821a's pass), so an extra key in the jsonb payload is
--                       read by nothing. Verified: 8 keys live, no behaviour change.
--   PROD, DB first    : BREAKS, as above.
--   PROD, UI first    : also breaks - the wizard reads `undefined`, the new code's
--                       `!== false` calls that ON, and Screen 3 fetches a document
--                       no provider has published.
-- Neither order is safe on prod on its own, so the two must land TOGETHER there, and
-- together is still not sufficient: with the document default-ON and nothing
-- published, every provider's Screen 3 blocks. That transition needs a decision
-- (seed each existing org a starting version vs. ship it off for existing orgs) and
-- it is Jessica's, not this migration's. Until then prod stays at 7 keys.
--
-- NOT TOUCHED, and easy to confuse with this: `contractor_agreements
-- .confirm_contractor_status`, the boolean an instructor ticks when signing. That is
-- a different thing with signed rows on prod, and it stays exactly as it is.

-- FORMATTED TO MATCH 20260813a / 20260821a CHARACTER-FOR-CHARACTER, plus the one
-- restored key. Not pasted from pg_get_viewdef: that prints capitalised keywords,
-- `::text` casts on the jsonb arrows and an extra paren pair around each COALESCE
-- argument. Semantically identical, textually different - and
-- src/lib/instructorDocuments.test.mjs parses this file to pin every key's
-- resolution, so the variation fails assertions for no reason. Keep it lowercase,
-- one key per two lines, so a future diff against the siblings shows only what
-- actually changed.
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
      -- FIRST, because this list is kept in the order an instructor meets the
      -- documents and contractor_status is Screen 3. Ordering inside
      -- jsonb_build_object has no effect on the stored jsonb; it is here so this
      -- enumeration reads in the same order as INSTRUCTOR_DOCUMENTS.
      'contractor_status',
        coalesce((instructor_document_config -> 'contractor_status') <> 'false'::jsonb, true),
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
