-- 20260801d_alert_email_operator_editable.sql
--
-- Companion to 20260731f_alert_email_is_the_tenants.sql. That migration made
-- organizations.alert_email always the TENANT's own address and populated it at
-- signup from two triggers. It did NOT give the operator any way to change it:
-- nothing in the admin UI wrote organizations.alert_email or organizations.email
-- (EmailSenderSettings wrote org_branding.email_reply_to and
-- organizations.mailing_address only).
--
-- That mattered because commit d7dbe6d made every alert whose BODY carries
-- tenant data (a contractor's name, a background-check result, a failed payout)
-- route to the tenant's own inbox and REFUSE to send when there is none, rather
-- than falling back to the Enrops platform inbox. Correct, but it left an
-- operator with no self-serve way out, and the broken state is reachable by the
-- operator themselves: guard_organizations_locked_columns does not lock
-- alert_email, and the members_update_own_org policy accepts an owner clearing
-- it (proven under a real owner JWT: PATCH {alert_email:null, email:null} -> 200).
--
-- This migration adds the DB half of the new admin field. The UI half is
-- src/pages/admin/EmailSenderSettings.jsx.
--
-- WHAT THIS DOES NOT DO: it does not make alert_email NOT NULL. Null is a
-- legitimate state that means "use organizations.email instead" -- that is the
-- coalesce loadOrgBrand() already performs for tenant_alert_email. The UI blocks
-- only the genuinely-broken case (clearing alert_email when organizations.email
-- is also null), because that is the one that leaves alerts with nowhere to go.

-- ---------------------------------------------------------------------------
-- Format check, so an operator cannot save something that will never deliver.
--
-- Deliberately the SAME shape as isPlausibleEmail() in
-- supabase/functions/_shared/orgBrand.ts and isPlausibleEmail() in
-- src/pages/admin/EmailSenderSettings.jsx: one address that is not whitespace,
-- one @, a dot in the domain. Not an RFC 5322 validator -- Resend still gates
-- actual delivery. The point is to reject the typo class ("jessica@enrops",
-- "jessica @enrops.com", a pasted "Name <a@b.com>") at the write, not to be
-- clever, and to enforce it in the DB as well as the UI so a direct PostgREST
-- PATCH cannot get around the field.
--
-- Verified safe before adding: 0 rows on staging and 0 on prod violate this
-- (8 orgs / 7 orgs, all alert_email populated and all well-formed), so the
-- constraint validates existing data rather than needing NOT VALID.
--
-- NULL is explicitly allowed -- see the note above.
-- ---------------------------------------------------------------------------
alter table public.organizations
  drop constraint if exists organizations_alert_email_format;

alter table public.organizations
  add constraint organizations_alert_email_format
  check (
    alert_email is null
    or alert_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  );

comment on column public.organizations.alert_email is
  'Where THIS provider''s own operational alerts go (background checks needing review, a card declining on a payment plan, a failed bank transfer). Always the tenant''s own address, never the platform''s. Seeded at signup by trg_org_default_alert_email / trg_owner_sets_alert_email (20260731f), and editable by an owner/admin at /admin/email-sender (20260801d). NULL means fall back to organizations.email; when BOTH are null, alerts carrying tenant data are refused rather than sent to Enrops.';
