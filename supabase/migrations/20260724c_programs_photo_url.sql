-- Program photo (registration WOW item, Arielle's checklist).
-- ADDITIVE + INERT: nullable, no default, no backfill. Every existing program
-- keeps photo_url = NULL and every current surface renders exactly as before.
-- Images live in the EXISTING public `org-assets` bucket under
-- <org_id>/program-photos/<ts>.<ext> — that path prefix satisfies the existing
-- org_assets_org_admin_insert RLS policy, so no new bucket or policy is needed.
-- We store the public URL (same convention as organizations.logo_url / banner).
alter table public.programs
  add column if not exists photo_url text;

comment on column public.programs.photo_url is
  'Public URL of the program photo in the org-assets bucket. NULL = no photo (renders the existing no-image card).';
