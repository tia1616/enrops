-- 2026-06-06 — Stop public file *listing* on the public asset buckets
-- (org-assets, public-assets). These are public buckets, so object content is
-- still served via the public CDN URL (/storage/v1/object/public/<bucket>/...)
-- with no storage.objects SELECT policy needed. Nothing in the app calls
-- .list()/.download() on them (verified by grep); logos are read via public URLs
-- only. Removing these broad SELECT policies removes the ability to enumerate
-- filenames.
--
-- Reversible — to restore listing, recreate:
--   create policy "Public read access" on storage.objects for select using (bucket_id = 'public-assets');
--   create policy "Public read access to org assets" on storage.objects for select using (bucket_id = 'org-assets');
drop policy if exists "Public read access" on storage.objects;
drop policy if exists "Public read access to org assets" on storage.objects;
