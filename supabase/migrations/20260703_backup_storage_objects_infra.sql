-- 20260703_backup_storage_objects_infra.sql
--
-- PROD-ONLY operational infra for off-site backup of the three PRIVATE storage
-- buckets to Cloudflare R2 (edge fn `backup-storage-objects`). Supabase PITR
-- covers Postgres but NOT storage objects; BGC PDFs / signed agreements can't be
-- re-created. Darren's pre-launch must-do #1. Staging holds only synthetic data,
-- so this is NOT a staging-parity concern.
--
-- This migration ships the one re-runnable piece: the service-role-only object
-- lister. The rest was applied directly on prod because it involves real secrets
-- / scheduling and must not be blindly re-run:
--   1. Vault secrets (DO NOT commit values):
--        r2_backup_config    -- JSON {endpoint,bucket,access_key_id,secret_access_key}
--        backup_cron_secret  -- random gate secret for the edge fn endpoint
--      via: select vault.create_secret('<value>', '<name>', '<desc>');
--   2. Edge fn supabase/functions/backup-storage-objects/ deployed verify_jwt=false
--      (authenticates callers against backup_cron_secret). Reads secrets via
--      public.app_secret() (added in 20260630_replay_digest_infra.sql).
--   3. pg_cron 'backup-storage-objects-weekly' (schedule '0 9 * * 0' = Sun ~2am PT):
--        select cron.schedule('backup-storage-objects-weekly', '0 9 * * 0', $job$
--          select net.http_post(
--            url := 'https://iuasfpztkmrtagivlhtj.supabase.co/functions/v1/backup-storage-objects',
--            headers := jsonb_build_object('Content-Type','application/json',
--              'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='backup_cron_secret')),
--            body := '{}'::jsonb, timeout_milliseconds := 150000));
--        $job$);
--
-- First run verified 2026-07-03: 82/82 objects copied (~65MB), R2 ListObjectsV2
-- reported 82 keys back. R2 layout: <r2-bucket>/<source-bucket>/<source-path>.
-- We never delete from R2, so a file deleted/corrupted in prod survives in backup.

create or replace function public.list_private_backup_objects()
returns table(bucket_id text, name text, size bigint, mimetype text, updated_at timestamptz)
language sql
security definer
set search_path = ''
as $$
  select o.bucket_id,
         o.name,
         (o.metadata->>'size')::bigint,
         o.metadata->>'mimetype',
         o.updated_at
  from storage.objects o
  where o.bucket_id in ('contractor-documents','curriculum-documents','program-documents')
    and o.name not like '%.emptyFolderPlaceholder'
$$;

revoke all on function public.list_private_backup_objects() from public, anon, authenticated;
grant execute on function public.list_private_backup_objects() to service_role;

comment on function public.list_private_backup_objects() is
  'Service-role-only lister of private storage objects for off-site R2 backup (backup-storage-objects edge fn). Never grant to anon/authenticated.';
