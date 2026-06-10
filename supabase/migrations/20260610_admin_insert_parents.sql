-- Allow org admins to create parent records and link them via parent_org_relationships.
-- Needed for the roster edit modal when a student has no linked parent.

-- Admin INSERT on parents: any authenticated org member can create a parent.
-- Parents have no organization_id, so we gate on "caller is a member of at least one org."
CREATE POLICY admins_create_parents
  ON public.parents
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.org_members
      WHERE org_members.auth_user_id = auth.uid()
    )
    OR public.is_platform_admin()
  );

-- Admin INSERT on parent_org_relationships: scoped to orgs the caller belongs to.
CREATE POLICY admins_create_parent_org_rels
  ON public.parent_org_relationships
  FOR INSERT
  WITH CHECK (
    public.is_org_member(organization_id)
    OR public.is_platform_admin()
  );
