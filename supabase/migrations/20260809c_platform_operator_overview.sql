-- 20260809c_platform_operator_overview.sql
--
-- Arielle's question, verbatim: "Is there a single place that tells me, per
-- operator: do they have an account, have they published, and when?" There was
-- not. platform_admins already gave her cross-tenant READ at the database layer
-- (she was added 2026-07-28), but the only screens behind it are refund-watch
-- and extraction-test, so the permission had nowhere to be used.
--
-- One read-only rollup, one row per organization. Additive and inert: creates a
-- function, touches no table, changes no existing behaviour.
--
-- Platform-wide by definition, so it RAISES rather than returning zero rows when
-- the caller is not a platform admin. Same reasoning as 20260806c: a silent zero
-- on this screen reads as "nobody has published anything", which is the exact
-- false reassurance the screen exists to prevent. get_operator_refund_rates()
-- already sets this precedent (`RAISE EXCEPTION 'forbidden'`); this matches it.
--
-- SECURITY DEFINER is load-bearing here for two reasons: the caller needs to see
-- EVERY org (RLS on organizations/programs/registrations scopes an operator to
-- their own), and last_sign_in_at lives in auth.users, which authenticated
-- cannot read at all.
create or replace function public.platform_operator_overview()
returns table (
  org_id                   uuid,
  org_name                 text,
  org_slug                 text,
  org_is_internal          boolean,
  org_platform_plan        text,
  org_created_at           timestamptz,
  stripe_charges_enabled   boolean,
  member_count             integer,
  accepted_member_count    integer,
  signed_in_member_count   integer,
  last_sign_in_at          timestamptz,
  live_program_count       integer,
  live_camp_count          integer,
  first_published_at       timestamptz,
  registration_count       integer,
  active_registration_count integer,
  first_registration_at    timestamptz,
  last_registration_at     timestamptz,
  last_activity_at         timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select
    o.id,
    o.name,
    o.slug,
    coalesce(o.is_internal, false),
    o.platform_plan,
    o.created_at,
    coalesce(o.stripe_charges_enabled, false),
    m.member_count,
    m.accepted_count,
    m.signed_in_count,
    m.last_sign_in_at,
    p.live_count,
    c.live_count,
    -- least() ignores NULLs in Postgres, so an org with programs but no camps
    -- (or the reverse) still gets a real date instead of NULL.
    least(p.first_live_at, c.first_live_at),
    r.reg_count,
    r.active_count,
    r.first_at,
    r.last_at,
    -- The honest activity signal. auth.users.last_sign_in_at is NOT usable for
    -- this: Supabase only stamps it on a fresh sign-in, not on a token refresh,
    -- so a daily user who never gets logged out looks dormant for weeks. (The
    -- Ukulele Project read "last login 7/22" on prod while publishing programs
    -- on 8/6.) Work done - a program created, a registration taken - is the
    -- thing that cannot be stale.
    greatest(p.last_created_at, c.last_created_at, r.last_at)
  from organizations o
  left join lateral (
    select
      count(*)::int                                                    as member_count,
      count(*) filter (where om.accepted_at is not null)::int           as accepted_count,
      count(*) filter (where u.last_sign_in_at is not null)::int        as signed_in_count,
      max(u.last_sign_in_at)                                           as last_sign_in_at
    from org_members om
    -- LEFT join: an invited-but-never-accepted member has no auth_user_id yet
    -- and must still be counted in member_count.
    left join auth.users u on u.id = om.auth_user_id
    where om.organization_id = o.id
  ) m on true
  left join lateral (
    select
      count(*) filter (where pr.status = 'open')::int                   as live_count,
      min(pr.created_at) filter (where pr.status = 'open')              as first_live_at,
      max(pr.created_at)                                                as last_created_at
    from programs pr
    where pr.organization_id = o.id
  ) p on true
  left join lateral (
    -- camp_sessions is the camps-shaped sibling of programs; its live state is
    -- 'active', not 'open'. J2S is the only org on prod with camps, but leaving
    -- them out would report J2S's first publish as programs-only.
    select
      count(*) filter (where cs.status = 'active')::int                 as live_count,
      min(cs.created_at) filter (where cs.status = 'active')            as first_live_at,
      max(cs.created_at)                                                as last_created_at
    from camp_sessions cs
    where cs.organization_id = o.id
  ) c on true
  left join lateral (
    select
      count(*)::int                                                     as reg_count,
      -- coalesce so a NULL status counts as active rather than silently
      -- vanishing from both counts.
      count(*) filter (where coalesce(rg.status, '') <> 'cancelled')::int as active_count,
      min(rg.registered_at)                                             as first_at,
      max(rg.registered_at)                                             as last_at
    from registrations rg
    where rg.organization_id = o.id
  ) r on true
  order by o.created_at;
end;
$$;

-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on new functions to public,
-- which includes anon. Revoke first, then grant narrowly (see 20260806c).
revoke all on function public.platform_operator_overview() from public;
revoke all on function public.platform_operator_overview() from anon;
-- service_role gets EXECUTE from the same default-privileges rule, and `revoke
-- from public` does NOT strip an explicit role grant - verified by reading proacl
-- back after the first apply, which still showed service_role=X. Revoked
-- explicitly: is_platform_admin() reads auth.uid(), which is NULL under
-- service_role, so a backend caller could only ever get the 42501 anyway.
-- Nothing server-side needs this; if that changes, add an explicit service_role
-- branch to the guard rather than a bare grant.
revoke all on function public.platform_operator_overview() from service_role;
grant execute on function public.platform_operator_overview() to authenticated;
