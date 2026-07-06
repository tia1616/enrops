-- Slice 1 of the automations phase: per-tenant email signature (text + optional image).
-- Signature TEXT + IMAGE URL live on org_branding, next to the other email fields
-- (email_from_name / email_reply_to). Additive + nullable -> every existing org keeps
-- sending unchanged (no signature block renders until an org sets one).
alter table public.org_branding
  add column if not exists email_signature text,
  add column if not exists email_signature_image_url text;

comment on column public.org_branding.email_signature is
  'Per-tenant email signature body (HTML, produced by the friendly editor -- same safe subset as body_override). Rendered above the footer in every outgoing email. Null = no signature block.';
comment on column public.org_branding.email_signature_image_url is
  'Optional public URL (org-assets bucket) of a logo/headshot shown at the top of the signature.';

-- The signature image must be publicly fetchable by email clients, so it lives in the
-- public "org-assets" bucket. That bucket had NO write policies (logos were seeded by
-- service-role only), so self-serve upload was impossible. Add org-admin + platform-admin
-- write policies scoped to the org's own top-level folder ({org_id}/...), mirroring the
-- existing curriculum-documents policies verbatim. This also unblocks self-serve logo/
-- banner uploads generally. Reads stay public (bucket.public = true).

-- Org owners/admins: write only within their own org folder.
create policy org_assets_org_admin_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'org-assets'
    and ((storage.foldername(name))[1])::uuid in (
      select organization_id from org_members
      where auth_user_id = auth.uid() and role = any (array['owner','admin'])
    )
  );

create policy org_assets_org_admin_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'org-assets'
    and ((storage.foldername(name))[1])::uuid in (
      select organization_id from org_members
      where auth_user_id = auth.uid() and role = any (array['owner','admin'])
    )
  );

create policy org_assets_org_admin_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'org-assets'
    and ((storage.foldername(name))[1])::uuid in (
      select organization_id from org_members
      where auth_user_id = auth.uid() and role = any (array['owner','admin'])
    )
  );

-- Platform admins (Jessica setting a tenant up): write to any org folder.
create policy org_assets_platform_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'org-assets' and is_platform_admin());

create policy org_assets_platform_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'org-assets' and is_platform_admin());

create policy org_assets_platform_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'org-assets' and is_platform_admin());
