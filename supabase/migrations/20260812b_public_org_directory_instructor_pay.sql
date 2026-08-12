-- Expose instructor_pay_enabled to the onboarding wizard.
--
-- WHY. The Stripe Connect step is unconditional for every tenant: today
-- effectiveStepOrder only toggles the background check and training, so an
-- instructor at a provider who pays by cheque, bank transfer or payroll software
-- is still walked through handing Stripe their SSN and bank details for payouts
-- that will never arrive. Only one provider on the platform pays instructors
-- through Stripe.
--
-- THE AXIS ALREADY EXISTS AND IS ALREADY CORRECT.
-- organizations.instructor_pay_enabled is the circuit breaker for integrated
-- Stripe instructor pay: true for the one provider using it, false by column
-- default for everyone else, and pay-instructor already refuses to move money
-- when it is false. So this is not a new setting — it is an existing one that
-- the wizard could not see.
--
-- DELIBERATELY NOT instructor_pay_model. That column already means three things
-- (nav shape, pay rail, tier) and the spec for this build says not to add a
-- fourth. instructor_pay_enabled means exactly one thing: does money for
-- instructors move through Stripe here.
--
-- SAFE TO EXPOSE. It is a boolean about the provider's own payment plumbing,
-- carries no personal data, and this view is already read by anonymous visitors
-- for slug, name, logo and background-check copy. It tells a reader nothing they
-- could not infer from being asked (or not asked) for bank details.
--
-- STILL LOCKED FOR WRITES. A tenant cannot flip this for themselves: the
-- organizations guard trigger raises unless the caller is a platform admin (see
-- 20260528_lock_instructor_pay_enabled and its successors). Exposing it read-only
-- on the directory does not change that.
--
-- Column APPENDED at the end so `create or replace view` keeps the existing
-- grants, same as 20260812a.

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
      'contractor_agreement', true,
      'pay_schedule',         coalesce(instructor_document_config -> 'pay_schedule'         <> 'false'::jsonb, true),
      'attendance_policy',    coalesce(instructor_document_config -> 'attendance_policy'    <> 'false'::jsonb, true),
      'code_of_conduct',      coalesce(instructor_document_config -> 'code_of_conduct'      <> 'false'::jsonb, true),
      'mandatory_reporter_ack', coalesce(instructor_document_config -> 'mandatory_reporter_ack' <> 'false'::jsonb, true),
      'photo_video_release',  coalesce(instructor_document_config -> 'photo_video_release'  <> 'false'::jsonb, true),
      'vehicle_driving_ack',  coalesce(instructor_document_config -> 'vehicle_driving_ack'  <> 'false'::jsonb, true)
    ) as instructor_documents_public,
    -- coalesce for safety only; the column is NOT NULL with default false.
    coalesce(instructor_pay_enabled, false) as instructor_pay_enabled
  from organizations
  where status = 'active';
