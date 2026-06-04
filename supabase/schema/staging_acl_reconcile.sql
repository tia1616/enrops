-- Staging ACL reconciliation
-- Run AFTER restoring prod_baseline_*.sql into a fresh (empty) Supabase project.
--
-- WHY THIS EXISTS:
-- pg_dump captures prod's privileges, but a fresh Supabase project has PROJECT-LEVEL
-- default privileges (ALTER DEFAULT PRIVILEGES ... GRANT ALL/EXECUTE TO anon, authenticated)
-- that re-grant access on every restored function/table at CREATE time. That silently
-- defeats prod's explicit REVOKEs, leaving locked objects WIDE OPEN on the restored copy.
-- This script re-applies prod's locks so staging's access control faithfully mirrors prod.
--
-- Verified against prod (iuasfpztkmrtagivlhtj) on 2026-06-04. If prod's locked objects change,
-- re-derive this list (functions where anon/authenticated EXECUTE is revoked; relations where
-- anon/authenticated SELECT/INSERT/UPDATE/DELETE is revoked) and update here.

-- 1) SECURITY DEFINER / sensitive functions locked to service_role on prod
revoke execute on function public.log_enrollment_event(text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,timestamp with time zone,text) from public, anon, authenticated;
revoke execute on function public.replace_emergency_contacts(uuid,uuid,jsonb) from public, anon, authenticated;
revoke execute on function public.vault_create_secret_text(text,text) from public, anon, authenticated;
revoke execute on function public.vault_delete_secret(uuid) from public, anon, authenticated;
revoke execute on function public.vault_read_secret_text(uuid) from public, anon, authenticated;
revoke execute on function public.vault_update_secret_text(uuid,text) from public, anon, authenticated;

-- 2) PII / marketing relations restricted on prod
-- admin_registrations: PII view, fully locked from both roles
revoke all on public.admin_registrations from anon, authenticated;
-- marketing_campaigns: anon none; authenticated keeps SELECT + UPDATE only
revoke all on public.marketing_campaigns from anon;
revoke insert, delete on public.marketing_campaigns from authenticated;
-- marketing_recipients: anon none; authenticated SELECT only
revoke all on public.marketing_recipients from anon;
revoke insert, update, delete on public.marketing_recipients from authenticated;
-- marketing_sends: anon none; authenticated SELECT only
revoke all on public.marketing_sends from anon;
revoke insert, update, delete on public.marketing_sends from authenticated;
-- program_locations: anon has NO table-level SELECT, only column-level SELECT on 8 public columns
revoke select on public.program_locations from anon;
grant select (id, name, district, slug, address, created_at, organization_id, name_aliases) on public.program_locations to anon;
