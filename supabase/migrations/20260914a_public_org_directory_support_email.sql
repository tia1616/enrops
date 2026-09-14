-- The parent-facing "email us" address becomes the PROVIDER's own address.
--
-- WHY. The parent portal read its support address from a hardcoded map in
-- src/lib/tenants.js that contains exactly one key: j2s. getTenant() returns
-- null for every other provider, so Dashboard.jsx fell through to a literal
-- 'jessica@enrops.com' - the platform owner's personal inbox - and printed it to
-- every other provider's families in three places, including the Settings tab.
--
-- This is not hypothetical and it is not new. Measured 2026-09-14: a Ukulele
-- Project parent at Rieke Elementary needed the room number the night before the
-- first class, opened her portal, was told to email jessica@enrops.com, and did
-- - apologising for not being able to "find the right email". Jessica forwarded
-- it to the provider 84 minutes later. The same thing happened on 2026-08-19 to
-- a different parent of the SAME provider; the note in _shared/orgBrand.ts
-- correctly ruled out the email reply-to cascade as the cause and left it
-- unexplained. This view column is the surface that note could not find.
--
-- THE RULE, AND WHERE IT ALREADY LIVES. The backend already answers "what is
-- this provider's own address" in _shared/orgBrand.ts: org_branding.email_reply_to
-- first, then organizations.email. This column is that same cascade and nothing
-- else, so a family reading the portal and a family hitting reply on an email
-- land in the same inbox. Both legs are load-bearing on real data (prod, 9 active
-- orgs): shoreview-chess has ONLY the branding address, while branching-minds,
-- chase-youth, write-a-thank-you-note and yoga-playgrounds have ONLY
-- organizations.email. Dropping either leg would blank a live provider.
--
-- NO PLATFORM FALLBACK, DELIBERATELY. This mirrors tenant_alert_email in
-- orgBrand.ts: "when it is null the correct answer is to not send and say so
-- loudly, never to send to us instead." A provider with neither address yields
-- NULL here and the portal then renders its help text with no mailto at all -
-- exactly what RegisterSuccess.jsx already does for this same problem ("the
-- public org record doesn't carry the provider's email, and inventing one risks
-- a bounce"). Falling back to a platform address IS the bug being fixed; it must
-- not be re-introduced one layer down.
--
-- J2S CHANGES TOO, ON PURPOSE. Jessica, 2026-09-14, asked which address her own
-- families should see and chose the resolved one: J2S now resolves to
-- getintouch@journeytosteam.com (its org email and its existing email reply-to)
-- rather than the hardcoded support@journeytosteam.com. That keeps ZERO tenant
-- special-casing in the code and points her families at the address they already
-- reply to. support@journeytosteam.com remains hardcoded in the J2S-branded
-- public footer (PublicLayout.jsx, gated on slug === 'j2s'), which is out of
-- scope here and correctly shown to J2S families only.
--
-- ADDITIVE AND INERT. This only appends a column; every existing column keeps
-- its name, type and position, so no current reader changes behaviour. Applied
-- to staging and prod in the same pass (parity).
--
-- SECURITY POSTURE. public_org_directory has no security_invoker (reloptions is
-- null, verified on prod before this ran), so it executes with the view owner's
-- rights and anon reads it today. The new LEFT JOIN to org_branding inherits
-- exactly that, which is why the address must be one a provider already
-- publishes: it is the reply-to printed on every family email they send, and on
-- their own website. Nothing private is added. Grants are TABLE-level SELECT to
-- anon and authenticated (confirmed via information_schema.column_privileges,
-- not has_table_privilege, which lies about column grants), so the new column is
-- readable without a new GRANT - verified after this runs with a real anon
-- PostgREST request plus a control.

-- DO NOT ALIAS `organizations` HERE. The columns below are deliberately bare.
--
-- src/lib/instructorDocuments.test.mjs guards the seven instructor-document keys
-- by finding the NEWEST migration that redefines this view and regex-matching
-- `(instructor_document_config -> 'key') <> 'false'::jsonb` in its text. That
-- guard exists because this view had already been redefined three times in two
-- days and a later redefinition can silently drop or flip a key, which hands an
-- instructor a document their provider never published. Writing `o.` in front of
-- the column makes every one of those seven assertions fail - which is exactly
-- what happened on the first draft of this migration, and is the guard working,
-- not a test to route around.
--
-- `logo_url` is the one column that MUST be qualified: org_branding has a
-- logo_url of its own, so a bare reference is ambiguous the moment this join
-- exists. (`updated_at` also collides but is not selected.) Nothing else in the
-- select list appears in both tables, so everything else stays bare and the
-- guard keeps working. Verified after applying: every row's logo_url still
-- equals organizations.logo_url, including the rows where org_branding holds a
-- different one.
--
-- THE JOIN CANNOT FAN OUT. Adding a LEFT JOIN to a view that every public page
-- reads would duplicate an org in the catalogue if org_branding ever held two
-- rows for it. It cannot: organization_id IS org_branding's PRIMARY KEY
-- (org_branding_pkey), so one row per org is structural, not just true today.
-- Confirmed empirically too - the view returns exactly as many rows as there are
-- active organizations, before and after.
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
    -- NEW. The provider's own address, or NULL when they have none. Same cascade
    -- as orgBrand.ts's reply_to, minus its platform step (see the note above).
    -- nullif(btrim(...)) so a row holding whitespace reads as absent rather than
    -- rendering an empty mailto: link.
    coalesce(
      nullif(btrim(b.email_reply_to), ''),
      nullif(btrim(email), '')
    ) as support_email
  from public.organizations
  left join public.org_branding b on b.organization_id = organizations.id
  where status = 'active';

commit;
