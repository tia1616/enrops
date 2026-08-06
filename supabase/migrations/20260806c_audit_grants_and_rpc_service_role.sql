-- 20260806c_audit_grants_and_rpc_service_role.sql
--
-- Two defects found by verifying 20260806b against the LIVE prod catalog rather
-- than trusting the migration that created it.

-- ── 1. organization_money_audit was created wide open ────────────────────────
--
-- Supabase ships an ALTER DEFAULT PRIVILEGES that grants ALL on new tables in
-- `public` to anon AND authenticated. 20260806b's `grant select ... to
-- authenticated` was therefore ADDITIVE on top of a full-DML default, not a
-- replacement for it. Read off prod's information_schema after applying:
--
--   anon=DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--   authenticated=DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--
-- No rows were ever exposed: RLS is enabled and the only policy is SELECT, so
-- INSERT/UPDATE/DELETE are refused for lack of a policy (verified on staging as a
-- real operator: insert blocked 42501, update and delete matched zero rows). This
-- is the second layer, not the first. It matters because the whole point of this
-- table is that a fee change cannot be forged or erased, and "RLS is the only
-- thing standing between anon and DML on the audit log" is not a posture worth
-- keeping - one permissive policy added later, or RLS toggled off during an
-- incident, and the record becomes writable by the anonymous role.
--
-- anon loses everything: an unauthenticated visitor has no business knowing that
-- this table exists. authenticated keeps SELECT only, still row-filtered by
-- money_audit_read_own_org. service_role keeps full access - it is the trigger's
-- and the platform's path.
revoke all on public.organization_money_audit from anon;
revoke all on public.organization_money_audit from authenticated;
grant select on public.organization_money_audit to authenticated;

-- The sequence too: INSERT is refused by RLS, but a grant on the sequence lets a
-- role burn ids, and anon should not be able to touch it at all.
revoke all on sequence public.organization_money_audit_id_seq from anon;
revoke all on sequence public.organization_money_audit_id_seq from authenticated;

-- ── 2. the RPC returned 0 for service_role ───────────────────────────────────
--
-- org_pending_plan_families gated on `can_admin_org(p_org) or is_platform_admin()`.
-- Both read auth.uid(), which is NULL under service_role, so a backend caller got
-- 0 rather than the real count - and 0 here means "no families are mid-plan",
-- which is exactly the false reassurance the tri-state in the UI exists to avoid.
-- Nothing calls it from the backend today, so this is pre-emptive, but a silent
-- zero on a money predicate is a trap to leave lying around.
--
-- Mirrors the allowance guard_organizations_locked_columns already makes
-- (auth.role() = 'service_role' short-circuits), so the two agree on who is
-- trusted. anon stays revoked; the EXECUTE grants are unchanged.
create or replace function public.org_pending_plan_families(p_org uuid)
returns integer
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select count(distinct coalesce(r.parent_id::text, 'reg:' || r.id::text))::int
  from installments i
  join registrations r on r.id = i.registration_id
  where r.organization_id = p_org
    and i.status = 'pending'
    and (
      auth.role() = 'service_role'
      or public.can_admin_org(p_org)
      or public.is_platform_admin()
    );
$$;

revoke all on function public.org_pending_plan_families(uuid) from public;
revoke all on function public.org_pending_plan_families(uuid) from anon;
grant execute on function public.org_pending_plan_families(uuid) to authenticated;
grant execute on function public.org_pending_plan_families(uuid) to service_role;
