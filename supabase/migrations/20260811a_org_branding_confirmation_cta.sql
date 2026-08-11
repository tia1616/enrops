-- A real BUTTON on the confirmation page, with operator-editable wording.
-- Jessica 2026-08-11: "the 'visit our shop' needs to be a button. this box has to be
-- more noticable. and the provider needs to be able to edit the button text"
--
-- Deliberately TWO structured columns rather than a new marker inside
-- confirmation_page_html. That HTML goes through bodyEditorUtils' editableToHtml,
-- which is shared by every authored email body in the product; adding a
-- button-flavoured markdown token there would put every email at risk to serve one
-- page. A label/url pair is also what the operator actually edits.
--
-- Both nullable, no default: with no URL there is no button, so every existing
-- tenant's page is unchanged.
--
-- Applied to STAGING (mumfymlapolsfdnpewci) and PROD (iuasfpztkmrtagivlhtj) in the
-- same pass, 2026-08-11. Verified on both: text, is_nullable=YES, no default.
alter table public.org_branding
  add column if not exists confirmation_cta_label text,
  add column if not exists confirmation_cta_url   text;

comment on column public.org_branding.confirmation_cta_label is
  'Button wording on the post-checkout confirmation page (e.g. "Visit our shop"). Rendered as escaped TEXT inside the button, never as HTML. Falls back to a generic label when a URL is set but this is blank.';

comment on column public.org_branding.confirmation_cta_url is
  'Button destination on the confirmation page. The button renders ONLY when this is a http/https URL - checked at save time in /admin/branding and again at render time in RegisterSuccess.jsx, because this column is world-readable via public_read_branding and a javascript:/data: value must never reach an href.';
