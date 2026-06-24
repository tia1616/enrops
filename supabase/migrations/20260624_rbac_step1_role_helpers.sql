-- RBAC Step 1: canonical role helper functions (Owner/Admin/Staff/Viewer).
-- Spec: docs/handoffs/2026-06-08-roles-and-access-spec.md
-- Decisions (Jessica, 2026-06-24): money = Admin+ (owner/admin only); Staff is money-blind;
--   `instructor` dropped from role CHECK in a later step; `permissions` jsonb ignored.
--
-- These are RLS predicate helpers: self-scoped to auth.uid(), SECURITY DEFINER + pinned
-- search_path, mirroring is_org_member. They KEEP EXECUTE for anon/authenticated because
-- RLS policies reference them and the querying role needs EXECUTE for policy evaluation
-- (see 20260604_lock_anon_executable_definer_fns.sql — these are the "legit RLS helpers"
-- that migration explicitly says NOT to lock). They leak nothing: each reads only the
-- caller's own org_members row, and returns false for anon (auth.uid() is null).
--
-- accepted_at IS NOT NULL => invited-but-unaccepted members get no powers.
-- role IN (...) wrapped in EXISTS => null/unknown role default-denies (EXISTS yields false).

-- caller's role in the org (null if not an accepted member)
CREATE OR REPLACE FUNCTION public.org_role(p_org uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT role FROM org_members
  WHERE auth_user_id = auth.uid()
    AND organization_id = p_org
    AND accepted_at IS NOT NULL
  LIMIT 1;
$$;

-- operational write gate: owner/admin/staff (blocks viewer)
CREATE OR REPLACE FUNCTION public.can_edit_org(p_org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE auth_user_id = auth.uid()
      AND organization_id = p_org
      AND role IN ('owner','admin','staff')
      AND accepted_at IS NOT NULL
  );
$$;

-- workspace controls: settings, team, branding, Stripe -> owner/admin
CREATE OR REPLACE FUNCTION public.can_admin_org(p_org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE auth_user_id = auth.uid()
      AND organization_id = p_org
      AND role IN ('owner','admin')
      AND accepted_at IS NOT NULL
  );
$$;

-- money gate: refunds, payroll/payouts, revenue visibility -> owner/admin
-- (kept distinct from can_admin_org so Staff money powers can be loosened later in one place)
CREATE OR REPLACE FUNCTION public.can_handle_money(p_org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE auth_user_id = auth.uid()
      AND organization_id = p_org
      AND role IN ('owner','admin')
      AND accepted_at IS NOT NULL
  );
$$;

-- ownership actions: transfer/delete org, mint owner -> owner only
CREATE OR REPLACE FUNCTION public.is_org_owner(p_org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE auth_user_id = auth.uid()
      AND organization_id = p_org
      AND role = 'owner'
      AND accepted_at IS NOT NULL
  );
$$;
