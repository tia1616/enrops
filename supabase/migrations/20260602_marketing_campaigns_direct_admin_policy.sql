-- The existing `org_read_campaigns` policy (cmd=ALL) gates on the
-- check_org_access(uuid) SECURITY DEFINER function. We've seen the function
-- fail intermittently in browser sessions even though the underlying
-- org_members row clearly satisfies the check (mystery: auth.uid() not
-- resolving the way we expect inside SECURITY DEFINER + SET search_path).
-- The failure surfaces as a silent 403 on the Approve / Save-as-draft writes
-- from the campaign-creating user, which is exactly the click that ships
-- the campaign.
--
-- Adding a parallel policy using direct EXISTS instead of the wrapper
-- function. Same logical condition, no indirection. Either policy granting
-- access is enough for PostgREST (policies OR together).
create policy "campaigns_org_admin_direct"
on marketing_campaigns
for all
to authenticated
using (
  exists (
    select 1 from org_members
    where org_members.auth_user_id = auth.uid()
      and org_members.organization_id = marketing_campaigns.organization_id
      and org_members.role in ('owner', 'admin')
      and org_members.accepted_at is not null
  )
  or exists (
    select 1 from platform_admins
    where platform_admins.auth_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from org_members
    where org_members.auth_user_id = auth.uid()
      and org_members.organization_id = marketing_campaigns.organization_id
      and org_members.role in ('owner', 'admin')
      and org_members.accepted_at is not null
  )
  or exists (
    select 1 from platform_admins
    where platform_admins.auth_user_id = auth.uid()
  )
);
