-- Operator-authored block for the post-checkout confirmation page.
-- Lives on org_branding beside hero_headline/hero_subtext because those are the
-- existing home for operator-authored PUBLIC PAGE WORDING, edited at /admin/branding.
-- Nullable with no default: NULL means render nothing, so every existing tenant's
-- confirmation page is byte-identical until an operator writes something.
--
-- Applied to STAGING (mumfymlapolsfdnpewci) and PROD (iuasfpztkmrtagivlhtj) in the
-- same pass, 2026-08-10. Verified on both: text, is_nullable=YES, no default.
alter table public.org_branding
  add column if not exists confirmation_page_html text;

comment on column public.org_branding.confirmation_page_html is
  'Operator-authored HTML block shown on the post-checkout confirmation page (RegisterSuccess.jsx). NULL = render nothing. Authored via /admin/branding and produced by editableToHtml, which entity-escapes operator text and sanitizes link hrefs to http/https/mailto only. Readable by anon via the existing public_read_branding policy (public_org_directory orgs), which is intended: this is public page copy.';
