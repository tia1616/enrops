-- Add an "emails_sent" win to the home wins: when a marketing campaign reaches
-- families in the last 7d, celebrate the outreach (label = families reached,
-- detail = campaign name). Joy is earned — a real send is real effort + reach.
-- Idempotent (create or replace); keeps the existing 3 win branches + limit 3.
CREATE OR REPLACE FUNCTION public.get_home_wins(p_org uuid)
 RETURNS TABLE(win_type text, label text, detail text, happened_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with per as (
    select r.parent_id, r.registered_at,
           coalesce(p.term, 'c:' || cs.cycle_id::text) as period,
           pa.first_name, pa.last_name
    from registrations r
    left join programs p on p.id = r.program_id
    left join camp_sessions cs on cs.id = r.camp_session_id
    left join parents pa on pa.id = r.parent_id
    where r.organization_id = p_org and r.status = 'confirmed'
  )
  -- Returning family: re-enrolled in a NEW term/cycle in last 30d, had a prior one.
  select 'returning_family'::text,
         coalesce(nullif(trim(a.last_name), ''), a.first_name, 'A family'),
         null::text,
         max(a.registered_at)
  from per a
  where a.registered_at >= now() - interval '30 days'
    and exists (select 1 from per b
                where b.parent_id = a.parent_id and b.period <> a.period
                  and b.registered_at < a.registered_at)
  group by a.parent_id, a.last_name, a.first_name

  union all
  -- Hire cleared end-to-end in last 14d.
  select 'hire_cleared'::text,
         coalesce(nullif(trim(i.preferred_name), ''), i.first_name, 'A new hire'),
         null::text,
         cos.completed_at
  from contractor_onboarding_status cos
  join instructors i on i.id = cos.instructor_id
  where cos.organization_id = p_org
    and cos.overall_status = 'complete'
    and cos.completed_at >= now() - interval '14 days'

  union all
  -- Full class that filled in last 7d.
  select 'full_class'::text, cs.curriculum_name, cs.location_name,
         (select max(r.registered_at) from registrations r
            where r.camp_session_id = cs.id and r.status = 'confirmed')
  from camp_sessions cs
  join curricula cu on cu.id = cs.curriculum_id
  where cs.organization_id = p_org
    and cu.class_size_max > 0
    and cs.current_enrollment >= cu.class_size_max
    and (select max(r.registered_at) from registrations r
           where r.camp_session_id = cs.id and r.status = 'confirmed') >= now() - interval '7 days'

  union all
  -- Outreach landed: a marketing campaign reached families in the last 7d.
  select 'emails_sent'::text,
         count(*)::text,
         mc.name,
         max(ms.sent_at)
  from marketing_sends ms
  join marketing_campaigns mc on mc.id = ms.campaign_id
  where ms.organization_id = p_org
    and ms.status = 'sent'
    and ms.sent_at >= now() - interval '7 days'
  group by mc.id, mc.name

  order by 4 desc nulls last
  limit 3;
$function$
