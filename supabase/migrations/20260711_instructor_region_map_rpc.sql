-- 2026-07-11 — Instructors need the org's venue->region map to pick location
-- preferences on the camp availability form (src/pages/j2s/InstructorAvailabilityForm.jsx).
--
-- Bug (codex 5-day review, finding #5): the form read organizations.venue_region_map
-- directly, but the organizations RLS policy members_read_own_org =
-- (is_org_member(id) OR is_platform_admin()) only permits accepted org members +
-- platform admins. Instructors sign in via magic link as themselves and are NOT
-- org_members, so the read returned zero rows. The form silently coalesced that
-- RLS failure to an empty map, showed no location areas, and saved no location
-- preferences. match-instructors then treated the missing preferences as
-- "available anywhere," degrading assignment quality.
--
-- Fix: a self-scoping SECURITY DEFINER RPC that exposes ONLY venue_region_map
-- (never the full organizations row) and only to a caller who is an instructor of
-- that org. Mirrors get_my_camp_coinstructors (2026-06-08): self-checks via
-- instructors.auth_user_id = auth.uid(), locked to `authenticated`, revoked from
-- public/anon per the SECURITY DEFINER grants rule.
--
-- Returns the map jsonb when the caller is an instructor of p_org_id; NULL when
-- the caller is not authorized OR the org simply hasn't configured a map. The
-- frontend distinguishes a genuine RPC error (surfaced) from a NULL/empty map
-- (org not configured — legitimately no regions).

create or replace function public.get_instructor_region_map(p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select o.venue_region_map
  from organizations o
  where o.id = p_org_id
    and exists (
      select 1
      from instructors i
      where i.auth_user_id = auth.uid()
        and i.organization_id = p_org_id
    );
$$;

revoke all on function public.get_instructor_region_map(uuid) from public, anon;
grant execute on function public.get_instructor_region_map(uuid) to authenticated;
