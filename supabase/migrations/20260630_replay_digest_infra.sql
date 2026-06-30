-- 20260630_replay_digest_infra.sql
--
-- PROD-ONLY operational infra for the Mon/Wed/Fri "replay digest" email
-- (edge fn `replay-digest` emails Jessica the new admin session recordings).
-- Staging has no real users to digest, so this lives on prod only — NOT a
-- staging-parity concern.
--
-- This migration ships the one re-runnable piece: the service-role-only secret
-- accessor. The rest was applied manually on prod because it involves real
-- secrets / scheduling and must not be blindly re-run:
--   1. Vault secrets (DO NOT commit values):
--        posthog_read_key           -- PostHog personal API key, session-recording:read
--        replay_digest_cron_secret  -- random gate secret for the edge fn endpoint
--      via: select vault.create_secret('<value>', '<name>', '<desc>');
--   2. Edge fn `supabase/functions/replay-digest/` deployed with verify_jwt=false
--      (it authenticates callers itself against replay_digest_cron_secret).
--   3. pg_cron job 'replay-digest-mwf' (schedule '0 15 * * 1,3,5' = ~8am PT):
--        select cron.schedule('replay-digest-mwf', '0 15 * * 1,3,5', $job$
--          select net.http_post(
--            url := 'https://iuasfpztkmrtagivlhtj.supabase.co/functions/v1/replay-digest',
--            headers := jsonb_build_object('Content-Type','application/json',
--              'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='replay_digest_cron_secret')));
--        $job$);

-- Service-role-only accessor for Vault secrets (the edge fn reads its keys
-- through this — Vault's schema isn't reachable via PostgREST directly).
-- Locked per feedback_security_definer_grants: revoked from public/anon/authenticated.
create or replace function public.app_secret(p_name text)
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name
$$;

revoke all on function public.app_secret(text) from public, anon, authenticated;
grant execute on function public.app_secret(text) to service_role;

comment on function public.app_secret(text) is
  'Service-role-only reader for Vault secrets (used by the replay-digest edge fn). Never grant to anon/authenticated.';
