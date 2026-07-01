-- Tighten marketing_campaigns writes to org admins (owner/admin) only.
--
-- Before: a single FOR ALL policy (org_read_campaigns, USING check_org_access)
-- let ANY accepted org member — including viewer/staff — rename, pause, cancel,
-- or APPROVE/SEND a campaign. Campaigns are a money/comms surface (Admin+ per
-- the RBAC rules). Split the ALL policy into:
--   * member read  — any accepted member (unchanged read access)
--   * admin write  — UPDATE gated to owner/admin (can_admin_org)
-- INSERT + DELETE stay service-role-only (draft create runs in
-- marketing-draft-campaign; delete runs in marketing-delete-draft), so no
-- authenticated INSERT/DELETE policy is created — those ops remain denied for
-- the anon/user client, which is what we want.
--
-- Additive-safe to run standalone on staging or prod.

DROP POLICY IF EXISTS org_read_campaigns ON public.marketing_campaigns;

CREATE POLICY campaigns_member_read ON public.marketing_campaigns
  FOR SELECT
  USING (public.check_org_access(organization_id) OR public.is_platform_admin());

CREATE POLICY campaigns_admin_write ON public.marketing_campaigns
  FOR UPDATE
  USING (public.can_admin_org(organization_id) OR public.is_platform_admin())
  WITH CHECK (public.can_admin_org(organization_id) OR public.is_platform_admin());
