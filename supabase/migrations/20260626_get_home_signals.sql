-- Heads-up "Important today" counts in one RLS-respecting round-trip.
-- SECURITY INVOKER (default): each subquery runs as the caller, so cross-tenant
-- reads return 0 (underlying-table RLS filters to the caller's orgs). Aggregate
-- counts only (cards are aggregate, not per-item). Open-hires stays in JS so it
-- mirrors Schedule.jsx exactly. Idempotent (create or replace).
create or replace function public.get_home_signals(p_org uuid)
returns table(
  low_enrollment int,
  change_requested int,
  offers_awaiting int,
  sub_coverage int,
  automation_off int,
  automation_off_name text,
  automation_off_detail text,
  finish_stripe boolean,
  next_start date
)
language sql
stable
set search_path to 'public'
as $$
  select
   (select count(*) from camp_sessions cs join curricula c on c.id = cs.curriculum_id
      where cs.organization_id = p_org and cs.status = 'active'
        and coalesce(cs.runs_own_registration, false) = false
        and cs.starts_on >= current_date and cs.starts_on <= current_date + 21
        and c.class_size_max > 0
        and coalesce(cs.current_enrollment, 0) < 0.5 * c.class_size_max)::int,
   ((select count(*) from camp_assignments where organization_id = p_org and status = 'change_requested')
    + (select count(*) from program_assignments where organization_id = p_org and status = 'change_requested'))::int,
   ((select count(*) from camp_assignments where organization_id = p_org and status = 'published' and instructor_response_at is null)
    + (select count(*) from program_assignments where organization_id = p_org and status = 'published' and instructor_response_at is null))::int,
   (select count(*) from assignment_substitutions where organization_id = p_org and status in ('pending', 'declined'))::int,
   (select count(*) from automations a join automation_templates t on t.id = a.template_id
      where a.organization_id = p_org and a.enabled = false and t.is_v1_enabled = true)::int,
   (select t.display_name from automations a join automation_templates t on t.id = a.template_id
      where a.organization_id = p_org and a.enabled = false and t.is_v1_enabled = true order by t.sort_order limit 1),
   (select t.description from automations a join automation_templates t on t.id = a.template_id
      where a.organization_id = p_org and a.enabled = false and t.is_v1_enabled = true order by t.sort_order limit 1),
   (select coalesce(o.stripe_account_status, '') <> 'active' from organizations o where o.id = p_org),
   (select min(d) from (
      select min(starts_on) d from camp_sessions where organization_id = p_org and status = 'active' and starts_on >= current_date
      union all
      select min(first_session_date) d from programs where organization_id = p_org and status = 'open' and first_session_date >= current_date
    ) x where d is not null);
$$;

revoke all on function public.get_home_signals(uuid) from anon, public;
grant execute on function public.get_home_signals(uuid) to authenticated;
