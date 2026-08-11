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
  'Operator-authored HTML block shown on the post-checkout confirmation page (RegisterSuccess.jsx). NULL = render nothing. TREAT THE STORED VALUE AS UNTRUSTED: this column is writable over the REST API by any org admin (members_write_branding = can_admin_org OR is_platform_admin), so the editor is not a gate. Safety comes from src/lib/sanitizeAuthoredHtml.js, applied at RENDER time on every read path. Readable by anon via public_read_branding (public_org_directory orgs), which is intended: this is public page copy.';
