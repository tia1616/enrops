-- Money doc section 9 item 14 (revenue by state) chunk two: the data source
-- for the /admin/platform/revenue-by-state screen. See
-- docs/handoffs/money-item14-revenue-by-state-2026-10-06.md.
--
-- Already applied to both staging and prod directly (inert, additive,
-- read-only reporting infra) - this file records it in git.

create or replace function public.platform_revenue_by_state(p_months_back integer default 12)
returns table (
  month date,
  state text,
  enrops_fee_cents bigint,
  pro_fee_cents bigint
)
language sql
stable
as $$
  with site_state as (
    select
      pl.id as location_id,
      -- Case-insensitive and zip-optional, matching the MOST tolerant of the
      -- codebase's existing address conventions (VenueEditor.jsx/AddSchoolModal.jsx's
      -- parseCity uses [A-Za-z]{2}\b with no zip requirement - this is a
      -- free-text field with no format enforcement, so matching the loosest
      -- accepted convention is the robust choice, not a new stricter one).
      -- upper() normalizes "or"/"OR" to the same bucket.
      coalesce(upper(substring(pl.address from ',\s*([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?(?:,|$)')), 'Unknown') as state
    from program_locations pl
  ),
  reg_state as (
    select
      r.id as registration_id,
      coalesce(ps.state, cms.state, 'Unknown') as state
    from registrations r
    left join programs p on p.id = r.program_id
    left join site_state ps on ps.location_id = p.program_location_id
    left join camp_sessions c on c.id = r.camp_session_id
    left join site_state cms on cms.location_id = c.location_id
  ),
  cutoff as (
    -- p_months_back=12 must return 12 calendar-month buckets ENDING with the
    -- current (partial) one - i.e. this month plus the 11 before it, not 12
    -- before it (which would be 13 buckets total, silently contradicting the
    -- UI's own "last 12 months" copy).
    select date_trunc('month', now()) - (greatest(p_months_back - 1, 0) || ' months')::interval as floor_month
  ),
  pay_in_full as (
    select
      date_trunc('month', r.registered_at)::date as month,
      rs.state,
      r.platform_fee_charged_cents as cents
    from registrations r
    join reg_state rs on rs.registration_id = r.id
    cross join cutoff
    where r.platform_fee_charged_cents is not null
      and r.registered_at >= cutoff.floor_month
  ),
  installment_charges as (
    select
      date_trunc('month', i.paid_at)::date as month,
      rs.state,
      i.platform_fee_charged_cents as cents
    from installments i
    join reg_state rs on rs.registration_id = i.registration_id
    cross join cutoff
    where i.platform_fee_charged_cents is not null
      and i.paid_at >= cutoff.floor_month
  ),
  combined as (
    select * from pay_in_full
    union all
    select * from installment_charges
  )
  select
    month,
    state,
    sum(cents)::bigint as enrops_fee_cents,
    0::bigint as pro_fee_cents
  from combined
  group by month, state
  order by month desc, state;
$$;

-- EXECUTE on a new function defaults to PUBLIC, which anon inherits directly -
-- revoking from public alone does NOT remove anon's own grant (the exact gap
-- that leaked parent emails on 2026-08-20). Both revokes are required.
revoke all on function public.platform_revenue_by_state(integer) from public;
revoke all on function public.platform_revenue_by_state(integer) from anon;
grant execute on function public.platform_revenue_by_state(integer) to authenticated;
