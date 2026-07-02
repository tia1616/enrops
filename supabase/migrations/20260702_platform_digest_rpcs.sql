-- Read RPCs for the platform-owner weekly digest. Both are cross-tenant (the
-- moat / owner view) and service_role ONLY — never anon/authenticated
-- (Intelligence Rule 5). Read the sealed intelligence schema directly.

-- Enrollment funnel summary (from enrollment_events).
create or replace function public.platform_funnel_summary(p_days int default 7)
returns jsonb
language sql
stable
security definer
set search_path = public, intelligence, pg_temp
as $$
  with rf as (
    select
      registration_id,
      bool_or(action_type = 'initiated')          as ini,
      bool_or(action_type = 'payment_completed')  as paid,
      bool_or(action_type = 'payment_failed')     as failed,
      bool_or(action_type = 'checkout_failed')    as cofailed,
      min(occurred_at) filter (where action_type = 'initiated') as ini_at
    from intelligence.enrollment_events
    where registration_id is not null
    group by registration_id
  )
  select jsonb_build_object(
    'window_days', p_days,
    'recent', jsonb_build_object(
      'initiated', count(*) filter (where ini and ini_at > now() - make_interval(days => p_days)),
      'paid',      count(*) filter (where ini and paid and ini_at > now() - make_interval(days => p_days))
    ),
    'all_time', jsonb_build_object(
      'initiated',       count(*) filter (where ini),
      'paid',            count(*) filter (where ini and paid),
      'abandoned',       count(*) filter (where ini and not paid and not failed and not cofailed),
      'payment_failed',  count(*) filter (where failed and not paid),
      'checkout_failed', count(*) filter (where cofailed and not paid)
    )
  )
  from rf;
$$;

revoke all on function public.platform_funnel_summary(int) from public, anon, authenticated;
grant execute on function public.platform_funnel_summary(int) to service_role;

-- Feature-usage summary (from platform_events): per feature, how many tenants used
-- it and how many successes/failures. Used-with-org-names is joined in the edge fn.
create or replace function public.platform_usage_summary(p_days int default 7)
returns jsonb
language sql
stable
security definer
set search_path = public, intelligence, pg_temp
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'feature', feature,
      'orgs', orgs,
      'org_ids', org_ids,
      'success', ok,
      'fail', fail
    ) order by (ok + fail) desc
  ), '[]'::jsonb)
  from (
    select
      feature,
      count(distinct organization_id)                    as orgs,
      jsonb_agg(distinct organization_id)
        filter (where organization_id is not null)       as org_ids,
      count(*) filter (where outcome = 'success')        as ok,
      count(*) filter (where outcome = 'fail')           as fail
    from intelligence.platform_events
    where occurred_at > now() - make_interval(days => p_days)
    group by feature
  ) s;
$$;

revoke all on function public.platform_usage_summary(int) from public, anon, authenticated;
grant execute on function public.platform_usage_summary(int) to service_role;

comment on function public.platform_usage_summary(int) is
  'Cross-tenant feature-usage rollup for the platform-owner digest. service_role only (Rule 5).';
