-- A provider can add their own logo to class photos, alongside the enrops mark.
--
-- OFF by default (Jessica, 2026-11-05): no provider's photos change until they
-- turn it on under Settings > Class photos. The enrops mark stays on every photo
-- either way; the logo is in addition to it, bottom-left.
--
-- Read by upload-class-photo (service role) and the Settings card (owner/admin
-- via the existing organizations UPDATE policy). organizations has table-level
-- grants to authenticated and service_role on both environments (verified
-- 2026-11-05), so a new column needs no grant. Not a money column: the locked-
-- columns guard is a deny-list of money fields and leaves this editable.
--
-- DEPLOY ORDER: this column first, then upload-class-photo, then the frontend.
-- Both read it in a .select(); either one ahead of this column fails its read.

alter table public.organizations
  add column if not exists class_photo_show_logo boolean not null default false;

comment on column public.organizations.class_photo_show_logo is
  'Stamp the provider''s logo (logo_email_url) on class photos, bottom-left, in addition to the enrops mark. Off by default.';
