-- A partner's requirements list is the PARTNER's, full stop (Jessica
-- 2026-11-20: "i shouldn't be able to edit partner requirements - shouldn't
-- even be a screen"; "why would i care about the partner portal, as a
-- provider, if the partner isn't on enrops? the point is to make enrops
-- valuable to partners"). The pattern of Homeroom, TrustLayer and myCOI: the
-- host sets what it requires; the vendor only provides.
--
-- 20261119p let the provider's owner/admin edit until the partner's first
-- change. That branch is removed: only the partner's admin login that sees
-- every site edits its list. The provider sees it read-only. A partner that
-- never edits keeps the standard defaults (private.partner_requirements_list)
-- and whatever the provider had set before today, which stays as it was.
--
-- requirements_editor (20261119p) restated; nothing else changes. Its callers
-- (set_partner_requirement, set_partner_requirement_detail,
-- partner_requirements_control) read it and need no change.

create or replace function private.requirements_editor(p_partner_id uuid, p_org uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  select case
    when auth.uid() is null then null
    when exists (
      select 1 from public.partner_portal_access a
      join public.partners p on p.id = a.partner_id
      where a.auth_user_id = auth.uid() and a.partner_id = p_partner_id
        and a.organization_id = p_org and a.role = 'host_admin'
        and a.site_ids is null
        and coalesce(p.inactive, false) = false
    ) then 'host_admin'
    else null
  end;
$$;
revoke all on function private.requirements_editor(uuid, uuid) from public, anon, authenticated;
