-- Add the end-of-term check-in signal to get_home_signals (completes the 9-card
-- heads-up spec). end_of_term = open AFTER-SCHOOL programs at a partner school whose
-- LAST session lands within 35 days. Afterschool-only on purpose: camps are one-week
-- one-offs, so "ending soon" there is constant noise, not a relationship check-in.
-- Last-session date comes from derive_program_session_dates() — NEVER hand-rolled
-- (memory feedback_session_date_function). Pruned by first_session_date so we don't
-- derive dates for every future FA term. Drop+recreate because the return signature
-- gains a column (CREATE OR REPLACE can't change return type). Idempotent.
drop function if exists public.get_home_signals(uuid);
create function public.get_home_signals(p_org uuid)
returns table(
  low_enrollment int,
  change_requested int,
  offers_awaiting int,
  sub_coverage int,
  end_of_term int,
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
   (select count(*) from programs p
      join program_locations pl on pl.id = p.program_location_id
      where p.organization_id = p_org and p.status = 'open' and pl.partner_id is not null
        and p.first_session_date is not null and p.first_session_date <= current_date + 35
        and (select max(d) from unnest(public.derive_program_session_dates(p.id)) d)
              between current_date and current_date + 35)::int,
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
