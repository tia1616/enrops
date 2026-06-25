-- Secure the organizations table — restrict public read to safe columns.
-- Spec: docs/handoffs/2026-06-25-secure-organizations-rls.md
--
-- Before: the only SELECT policy (public_read_active_orgs, role public, USING
-- status='active') exposed EVERY column of every active org to anyone — incl
-- stripe_account_id, platform_fee_*, apps_script_sync_secret, sending_domain,
-- pay_*, alert_email. RLS is row-level, not column-level.
--
-- After: members (and platform admin) read full columns of their OWN org; the
-- public reads a safe-column view (public_org_directory). 9 admin/member
-- frontend reads stay on `organizations`; 5 public/non-member reads (PublicLayout,
-- J2SLayout, PolicyPage, enrops Landing, OnboardingRouter) repoint to the view.
--
-- Verified on staging: anon read of sensitive cols from organizations -> []
-- (RLS denies); anon read of public_org_directory -> safe cols only; sensitive
-- cols through the view -> 400 (not present).

-- 1. Members (and platform admin) read their own org — full columns.
DROP POLICY IF EXISTS members_read_own_org ON public.organizations;
CREATE POLICY members_read_own_org ON public.organizations FOR SELECT
  USING (is_org_member(id) OR is_platform_admin());

-- 2. Drop the world-readable all-columns policy.
DROP POLICY IF EXISTS public_read_active_orgs ON public.organizations;

-- 3. Safe-column public directory. security_invoker=false → runs as owner,
--    bypasses RLS, exposes ONLY these non-sensitive columns for active orgs.
CREATE OR REPLACE VIEW public.public_org_directory
  WITH (security_invoker = false) AS
  SELECT id, slug, name, logo_url, logo_email_url, status, timezone
  FROM public.organizations
  WHERE status = 'active';
GRANT SELECT ON public.public_org_directory TO anon, authenticated;
