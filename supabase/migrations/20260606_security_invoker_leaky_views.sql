-- 2026-06-06 — Security hotfix: close cross-tenant exposure via SECURITY DEFINER views.
--
-- The advisor flagged `v_effective_pay_lines` and `program_enrollment` as
-- SECURITY DEFINER views (ERROR level). Because a DEFINER view runs with the
-- creator's privileges, it bypasses the row-level security on its base tables:
--   * v_effective_pay_lines exposed instructor pay (amounts, payouts, org_id)
--     across ALL tenants to the `anon` role (i.e. publicly, no sign-in).
--   * program_enrollment exposed every tenant's program names, locations, and
--     fill rates to `anon`.
--
-- The base tables (session_delivery_confirmations, instructors, camp_assignments,
-- program_assignments, assignment_substitutions, programs, program_locations,
-- registrations) already enforce org-scoped RLS with org_members SELECT policies,
-- so switching the views to SECURITY INVOKER re-applies that scoping:
--   * authenticated org admins still read their own org's rows (Payroll.jsx works),
--   * the pay-instructor edge function uses the service role and is unaffected,
--   * anon and other tenants get zero rows.
--
-- Applied to prod (iuasfpztkmrtagivlhtj) and staging (mumfymlapolsfdnpewci) on 2026-06-06.
-- Guarded so it is a no-op if a view is absent in a given environment.

do $$
begin
  if to_regclass('public.v_effective_pay_lines') is not null then
    execute 'alter view public.v_effective_pay_lines set (security_invoker = on)';
  end if;
  if to_regclass('public.program_enrollment') is not null then
    execute 'alter view public.program_enrollment set (security_invoker = on)';
  end if;
end $$;
