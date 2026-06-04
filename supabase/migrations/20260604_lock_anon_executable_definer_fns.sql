-- SECURITY FIX (6/4): lock anon/authenticated-executable SECURITY DEFINER functions
-- whose only legitimate caller is service_role (cron/edge functions) or a trigger.
--
-- Found by the security advisor during the guardrail audit. Root cause is the same
-- Supabase default-privileges gotcha that hit the intelligence doorway: every new
-- SECURITY DEFINER function in `public` is auto-granted EXECUTE to anon + authenticated,
-- so `revoke ... from public` alone does NOT block client roles.
--
-- DO NOT touch the legit RLS helper functions (is_org_member, current_parent_id,
-- user_org_ids, is_platform_admin, is_org_owner_or_admin, check_org_access) — RLS
-- policies reference them and the querying role needs EXECUTE for policy evaluation.

-- 1. get_campaign_recipients(uuid) — CRITICAL. SECURITY DEFINER, no internal auth check,
--    returns children's first/last names + home city/zip/school for every approved
--    recipient of a campaign. Was anon-executable via /rest/v1/rpc => a children's-PII
--    leak + an unbounded list endpoint over minors' data. Sole caller is the cron send
--    fn (marketing-touchpoint-send, service_role). Lock to service_role only.
revoke execute on function public.get_campaign_recipients(uuid) from public, anon, authenticated;
grant  execute on function public.get_campaign_recipients(uuid) to service_role;

-- 2. cron_unschedule_by_name(text) — anon could unschedule cron jobs (incl. installment
--    processing + marketing sends). Sole caller is contractor-onboarding-reminders
--    (service_role). Lock to service_role only.
revoke execute on function public.cron_unschedule_by_name(text) from public, anon, authenticated;
grant  execute on function public.cron_unschedule_by_name(text) to service_role;

-- 3. Trigger functions — fire from triggers regardless of EXECUTE grant; nobody needs to
--    call them directly via RPC. Revoke direct client access (defense in depth).
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
revoke execute on function public.recompute_camp_session_enrollment() from public, anon, authenticated;
revoke execute on function public.sync_instructor_onboarding_status() from public, anon, authenticated;
revoke execute on function public.guard_organizations_locked_columns() from public, anon, authenticated;
revoke execute on function public.auto_add_registrant_to_marketing_list() from public, anon, authenticated;
