-- The signature image is a CHOICE, not just a URL: "use my logo" must track the
-- org's current logo, not snapshot it. Store the mode so the send path can
-- resolve 'logo' to organizations.logo_email_url at send time.
-- null = legacy rows saved before this column (resolved by falling back to the
-- stored image URL, so existing signatures are unchanged).
alter table public.org_branding
  add column if not exists email_signature_image_mode text
    check (email_signature_image_mode in ('logo','custom','none'));

comment on column public.org_branding.email_signature_image_mode is
  'How the signature image resolves: logo = use the org logo (tracked live), custom = use email_signature_image_url, none = no image. Null = legacy (fall back to email_signature_image_url).';
