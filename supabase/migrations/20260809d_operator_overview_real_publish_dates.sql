-- 20260809d_operator_overview_real_publish_dates.sql
--
-- "we need published, not just open."
--
-- 20260809c approximated the publish moment with the creation date of the
-- earliest program that ever left draft, because programs has no published_at
-- column. It does not need one: intelligence.tg_program_published already fires
-- on every draft -> open transition, and intelligence.tg_program_created logs a
-- program_published for anything born open, so the real moment is already in
-- intelligence.platform_events. Adding a column and a trigger would have been a
-- second, competing record of the same fact.
--
-- The proxy was not merely imprecise, it was wrong in BOTH directions - checked
-- against live data, not reasoned about:
--   Cascade (staging) - events say 2026-07-16, the proxy said 2026-07-30. Two
--     weeks late, because the program they first published is no longer the
--     earliest-created open one.
--   Ukulele (prod) - events say 2026-08-04, the proxy said 2026-08-06.
--   J2S - events say 2026-07-02, the proxy says 2026-04-15, and the PROXY is
--     right: the event log only starts 2026-07-03. Nothing published before
--     then is in it.
--
-- So the answer is the earliest of three sources, not the event log alone:
--   1. the program_published event log        - exact, but only since 2026-07-03
--   2. the created_at of a program that ever  - a floor, reads early by however
--      left draft                               long it sat in draft
--   3. the created_at of a camp session       - exact; camp_sessions has no
--                                               draft state (CHECK is
--                                               active/cancelled), so a camp was
--                                               public the moment it existed
--
-- and the row says WHICH kind of answer it is, via first_published_is_exact.
-- Showing an estimate and an exact date in the same column with no way to tell
-- them apart is how a date nobody should act on gets acted on.
--
-- The signature gains a column, so this drops and recreates rather than
-- replaces. Safe: nothing on prod calls this yet.
drop function if exists public.platform_operator_overview();

create function public.platform_operator_overview()
returns table (
  org_id                    uuid,
  org_name                  text,
  org_slug                  text,
  org_is_internal           boolean,
  org_platform_plan         text,
  org_created_at            timestamptz,
  stripe_charges_enabled    boolean,
  member_count              integer,
  accepted_member_count     integer,
  signed_in_member_count    integer,
  last_sign_in_at           timestamptz,
  live_program_count        integer,
  live_camp_count           integer,
  first_published_at        timestamptz,
  first_published_is_exact  boolean,
  registration_count        integer,
  active_registration_count integer,
  first_registration_at     timestamptz,
  last_registration_at      timestamptz,
  last_activity_at          timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public', 'intelligence', 'pg_temp'
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
    -- least() ignores NULLs in Postgres, so an org present in only one of the
    -- three sources still gets a real date.
    least(ev.first_published_at, p.first_published_at, c.first_published_at),
    case
      when least(ev.first_published_at, p.first_published_at, c.first_published_at) is null
        then null
      -- The winning source decides. Ties go to the event log, then to camps -
      -- both are exact, and the draft proxy can only ever be a floor.
      when ev.first_published_at is not null
       and ev.first_published_at <= coalesce(p.first_published_at, ev.first_published_at)
       and ev.first_published_at <= coalesce(c.first_published_at, ev.first_published_at)
        then true
      when c.first_published_at is not null
       and c.first_published_at <= coalesce(p.first_published_at, c.first_published_at)
        then true
      else false
    end,
    r.reg_count,
    r.active_count,
    r.first_at,
    r.last_at,
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
    -- The exact record, where it exists. Scoped by organization_id, so the 39
    -- staging / 11 prod events carrying a NULL org are correctly excluded
    -- rather than silently attributed to somebody.
    select min(e.occurred_at) as first_published_at
    from intelligence.platform_events e
    where e.organization_id = o.id
      and e.feature = 'programs'
      and e.action  = 'program_published'
      and e.outcome = 'success'
  ) ev on true
  left join lateral (
    -- "How many are live right now" is status = 'open' - an allow-list, and
    -- correct, because that is the only status families can register against.
    --
    -- The publish FLOOR is a deny-list: the live CHECK is
    -- draft/open/closed/cancelled, so an operator who published in September
    -- and closed the class in October has zero 'open' rows, and reading that as
    -- "never published" is the wrong answer to the question this screen exists
    -- to answer. `status is not null` because a NULL status proves nothing
    -- either way and must not be read as evidence of publishing.
    select
      count(*) filter (where pr.status = 'open')::int                   as live_count,
      min(pr.created_at) filter (
        where pr.status is not null and pr.status <> 'draft'
      )                                                                 as first_published_at,
      max(pr.created_at)                                                as last_created_at
    from programs pr
    where pr.organization_id = o.id
  ) p on true
  left join lateral (
    -- camp_sessions is the camps-shaped sibling of programs; its live state is
    -- 'active', not 'open'. No draft filter and no event lookup: camps have no
    -- draft state, so created_at IS the publish moment and is exact.
    select
      count(*) filter (where cs.status = 'active')::int                 as live_count,
      min(cs.created_at)                                                as first_published_at,
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

-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on new functions to public
-- AND to service_role; `revoke from public` does not strip the explicit role
-- grant (verified by reading proacl back after 20260809c's first apply). Revoke
-- both, then grant narrowly. service_role stays out on purpose:
-- is_platform_admin() reads auth.uid(), which is NULL under service_role, so a
-- backend caller could only ever get the 42501.
revoke all on function public.platform_operator_overview() from public;
revoke all on function public.platform_operator_overview() from anon;
revoke all on function public.platform_operator_overview() from service_role;
grant execute on function public.platform_operator_overview() to authenticated;
