-- 20260721_family_registration_timeline_fn.sql
--
-- Returns a family's registrations for the Comms per-contact timeline, keyed by
-- email. Needed because marketing_recipients is email-keyed and the parents RLS
-- (members_see_org_parents) requires a parent_org_relationships link that MOST
-- registered parents lack (prod: 39 of 282), so a plain email->parents read
-- returns nothing for the admin. SECURITY DEFINER bypasses that gap but is gated
-- to org members and scoped to the passed org + email, so it can only ever return
-- the caller's own org data.

create or replace function public.family_registration_timeline(p_org uuid, p_email text)
returns table (
  registration_id uuid,
  registered_at timestamptz,
  cancelled_at timestamptz,
  status text,
  program_name text,
  starts_at date,
  child_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.registered_at, r.cancelled_at, r.status,
    coalesce(nullif(pr.curriculum, ''), cs.curriculum_name) as program_name,
    coalesce(pr.first_session_date, cs.starts_on) as starts_at,
    nullif(trim(concat_ws(' ', s.first_name, s.last_name)), '') as child_name
  from registrations r
  join parents p on p.id = r.parent_id
  left join programs pr on pr.id = r.program_id
  left join camp_sessions cs on cs.id = r.camp_session_id
  left join students s on s.id = r.student_id
  where r.organization_id = p_org
    and lower(p.email) = lower(p_email)
    and is_org_member(p_org)
  order by r.registered_at desc nulls last
  limit 200;
$$;

revoke all on function public.family_registration_timeline(uuid, text) from public;
revoke all on function public.family_registration_timeline(uuid, text) from anon;
grant execute on function public.family_registration_timeline(uuid, text) to authenticated;
