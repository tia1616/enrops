-- 20260809f_operator_overview_stripe_connected.sql
--
-- The screen is getting a Stripe column, because publishing a program is about
-- to require a connected Stripe account and Arielle needs to see who is behind
-- that wall.
--
-- stripe_charges_enabled alone cannot draw that column honestly. It is false for
-- two different operators: one who has never opened Stripe, and one who
-- connected an account that is not yet cleared to charge. Those need different
-- follow-ups - the first is "you have not started", the second is "you started
-- and something is unfinished on Stripe's side" - and a single boolean collapses
-- them into one tick-less cell that says neither.
--
-- Checked live before adding it. On prod the two states do not currently
-- overlap: j2s and the-ukulele-project have an account with charges on, and
-- yoga-playgrounds, shoreview-chess, mrs-richelle and chase-youth have no
-- account at all - nobody is stalled mid-way. On STAGING the stalled state is
-- real: demo-chess-center has stripe_account_id set with charges off. So the
-- three-way distinction is reachable today, not hypothetical.
--
-- stripe_connected is deliberately account-existence only. Whether that is also
-- the right gate for publishing is a separate decision - charges_enabled is the
-- stricter one, and is the flag that actually determines whether a family can
-- pay - so both are returned and the screen can say which is which.
--
-- Signature gains a column, so this drops and recreates. Nothing on prod calls
-- it yet.
drop function if exists public.platform_operator_overview();

create function public.platform_operator_overview()
returns table (
  org_id                    uuid,
  org_name                  text,
  org_slug                  text,
  org_is_internal           boolean,
  org_platform_plan         text,
  org_created_at            timestamptz,
  stripe_connected          boolean,
  stripe_charges_enabled    boolean,
  member_count              integer,
  signed_in_member_count    integer,
  last_sign_in_at           timestamptz,
  live_program_count        integer,
  live_camp_count           integer,
  first_published_at        timestamptz,
  first_published_is_exact  boolean,
  publish_log_starts_at     timestamptz,
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
declare
  v_log_starts_at timestamptz;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Platform-wide, computed once: the moment publishing began being recorded.
  -- Anything at or after this is an exact date; anything before it can only be
  -- the created_at floor. NULL when nothing has ever been published, in which
  -- case the screen states no cutoff at all rather than inventing one.
  select min(e.occurred_at) into v_log_starts_at
  from intelligence.platform_events e
  where e.feature = 'programs' and e.action = 'program_published' and e.outcome = 'success';

  return query
  select
    o.id,
    o.name,
    o.slug,
    coalesce(o.is_internal, false),
    o.platform_plan,
    o.created_at,
    -- "has an account at all", not "is finished". nullif so a blank string,
    -- which is not the same thing as a connected account, does not read as one.
    nullif(btrim(coalesce(o.stripe_account_id, '')), '') is not null,
    coalesce(o.stripe_charges_enabled, false),
    m.member_count,
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
    v_log_starts_at,
    r.reg_count,
    r.active_count,
    r.first_at,
    r.last_at,
    greatest(p.last_created_at, c.last_created_at, r.last_at)
  from organizations o
  left join lateral (
    select
      count(*)::int                                              as member_count,
      count(*) filter (where u.last_sign_in_at is not null)::int as signed_in_count,
      max(u.last_sign_in_at)                                     as last_sign_in_at
    from org_members om
    -- LEFT join: an invited member with no auth_user_id yet must still be
    -- counted in member_count.
    left join auth.users u on u.id = om.auth_user_id
    where om.organization_id = o.id
  ) m on true
  left join lateral (
    -- The exact record, where it exists. Scoped by organization_id, so events
    -- carrying a NULL org are correctly excluded rather than silently
    -- attributed to somebody.
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
    -- 'active', not 'open'. created_at IS the publish moment here and is exact,
    -- because camp_sessions_status_check is active/cancelled - there is no
    -- draft. The same deny-list the programs lateral uses is applied anyway, so
    -- that assumption is enforced by the query rather than by a comment.
    select
      count(*) filter (where cs.status = 'active')::int                 as live_count,
      min(cs.created_at) filter (
        where cs.status is not null and cs.status <> 'draft'
      )                                                                 as first_published_at,
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
-- grant. Revoke both, then grant narrowly. service_role stays out on purpose:
-- is_platform_admin() reads auth.uid(), which is NULL under service_role, so a
-- backend caller could only ever get the 42501.
revoke all on function public.platform_operator_overview() from public;
revoke all on function public.platform_operator_overview() from anon;
revoke all on function public.platform_operator_overview() from service_role;
grant execute on function public.platform_operator_overview() to authenticated;
