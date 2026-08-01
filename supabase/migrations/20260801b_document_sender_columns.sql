-- 20260801b_document_sender_columns.sql
--
-- DOCUMENTATION ONLY. No DDL, no data change, no behaviour change.
--
-- Context: the sender-config gap. Thirteen edge functions read
-- organizations.default_sender_email RAW and used it as the Resend From, which
-- failed two ways and both were silent:
--
--   1. NULL  -> `if (!org.default_sender_email) return;` the alert was never
--      sent and nothing was logged. public.provision_operator_org sets neither
--      default_sender_email nor default_sender_name, so EVERY self-serve signup
--      landed here. On prod that was chase-youth, the-ukulele-project and
--      yoga-playgrounds.
--   2. SET BUT UNVERIFIED -> interpolated straight into the From header. Resend
--      rejects a From on a domain it has not verified, so the send failed.
--
-- Fixed in code, not in data: every function now goes through
-- _shared/orgBrand.ts loadOrgBrand() + formatFromAddress(), which always
-- resolves to a verified address. That makes both columns advisory rather than
-- load-bearing, and this comment is here so the next person who reaches for
-- them knows that before they write `<${org.default_sender_email}>` again.
--
-- An earlier draft of this fix (20260801a) instead backfilled the column and
-- added a BEFORE INSERT trigger to keep it populated. It was reverted: once the
-- functions use the helper, storing the derived address means the same value is
-- computed in two places (the helper at send time, the trigger at insert time)
-- and can drift, and it makes a column the operator never configured look
-- configured. The trigger and function were dropped from staging; neither was
-- ever applied to prod.

comment on column public.organizations.default_sender_email is
  'ADVISORY, not the From address. Only used as the actual sender when its domain equals this org''s VERIFIED sending_domain; otherwise _shared/orgBrand.ts loadOrgBrand() ignores it and derives {slug}@{platform sending domain}. Never read this column raw to build a Resend From - an unverified domain here is rejected by Resend and the send fails silently. May legitimately be NULL: a provider who never opened Settings still sends fine.';

comment on column public.organizations.default_sender_name is
  'Display name for the From header, resolved by loadOrgBrand() as default_sender_name -> org_branding.email_from_name -> organizations.name. May be NULL; the cascade covers it. RFC 5322-encoded by formatFromAddress() before it reaches a header.';

comment on column public.organizations.sending_domain is
  'The org''s OWN Resend-verified sending domain. This is what makes default_sender_email actually usable as a From: loadOrgBrand() sends from the tenant''s address only when its domain matches this. NULL (the common case) means the org sends on the shared platform domain, which is always verified.';
