-- Partner portal Classes tab grouped by term (Kacy Cullen, Happy Valley,
-- 2026-11-19: "having them labeled by term could be helpful").
--
-- partner_portal_classes (20261119a, with 20261119a's later fixes) gains ONE
-- column, `term`: the class's own programs.term ("WI27"). Camps have no term
-- code (camp_sessions), so theirs is null and the page labels them by the
-- season of their dates (src/lib/partnerClasses.js termOfClass).
--
-- A new output column changes the function's return type, which CREATE OR
-- REPLACE cannot do, so it is dropped and recreated in one transaction with
-- the same grants. Every other line is the 20261119a body unchanged.

drop function if exists public.partner_portal_classes(uuid);

create function public.partner_portal_classes(p_partner_id uuid)
returns table(
  kind text, class_id uuid, title text, term text, site text,
  day_of_week text, class_days text[], start_time text, end_time text,
  first_date date, last_date date, status text,
  max_capacity integer, count_source text, enrolled integer, reported_on date,
  instructors text[]
)
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_org uuid;
  v_sites uuid[];
  v_ok boolean;
  v_today date;
  v_tz text;
  v_enrops boolean;
begin
  select s.organization_id, s.site_ids, s.allowed into v_org, v_sites, v_ok
  from private.partner_portal_scope(p_partner_id) s;
  if not coalesce(v_ok, false) then
    return;
  end if;
  -- Same timezone fallback as partner_portal_instructors.
  select coalesce(o.uses_enrops_registration, true), coalesce(o.timezone, 'America/Los_Angeles')
    into v_enrops, v_tz
  from public.organizations o where o.id = v_org;
  v_today := (now() at time zone v_tz)::date;

  return query
  with progs as (
    select pr.*, pl.name as site_name,
      (select array_agg(d order by d) from unnest(public.derive_program_session_dates(pr.id)) d) as dates
    from public.programs pr
    join public.program_locations pl on pl.id = pr.program_location_id
    where pl.partner_id = p_partner_id
      and (v_sites is null or pl.id = any(v_sites))
      and pr.organization_id = v_org
      -- Drafts too: the Instructors list already names who is assigned to a
      -- draft class at these sites, so the class it belongs to is shown, as
      -- 'draft' ("Not open yet"), rather than an instructor with no class.
      and pr.status in ('open', 'cancelled', 'draft')
  )
  select
    'class'::text,
    pr.id,
    pr.curriculum,
    pr.term,
    pr.site_name,
    pr.day_of_week,
    pr.class_days::text[],
    pr.start_time,
    pr.end_time,
    coalesce(pr.dates[1], pr.first_session_date),
    coalesce(pr.dates[array_length(pr.dates, 1)], pr.end_date, pr.first_session_date),
    case when pr.status in ('cancelled', 'draft') then pr.status else 'open' end,
    pr.max_capacity,
    case when pr.runs_own_registration then 'partner'
         when not v_enrops then 'provider'
         else 'enrops' end,
    case when pr.runs_own_registration then null
         when not v_enrops then (select re.enrolled from public.reported_enrollments re where re.program_id = pr.id)
         else (select count(*)::integer from public.registrations r
               where r.program_id = pr.id and r.student_id is not null and private.registration_on_roster(r)) end,
    case when not pr.runs_own_registration and not v_enrops
         then (select (re.reported_at at time zone v_tz)::date from public.reported_enrollments re where re.program_id = pr.id) end,
    (select array_agg(i.first_name || ' ' || i.last_name order by i.first_name, i.last_name)
       from public.program_assignments pa
       join public.instructors i on i.id = pa.instructor_id and i.organization_id = v_org and i.is_active
      where pa.program_id = pr.id and pa.organization_id = v_org and pa.status = 'confirmed')
  from progs pr
  where coalesce(pr.dates[array_length(pr.dates, 1)], pr.end_date, pr.first_session_date, v_today) >= v_today

  union all

  select
    'camp'::text,
    cs.id,
    cs.curriculum_name,
    null::text,
    pl.name,
    null::text,
    cs.class_days::text[],
    to_char(cs.start_time, 'FMHH12:MI AM'),
    to_char(cs.end_time, 'FMHH12:MI AM'),
    cs.starts_on,
    cs.ends_on,
    case when cs.status = 'cancelled' then 'cancelled' else 'open' end,
    cs.max_capacity,
    case when cs.runs_own_registration then 'partner'
         when not v_enrops then 'provider'
         else 'enrops' end,
    case when cs.runs_own_registration then null
         when not v_enrops then (select re.enrolled from public.reported_enrollments re where re.camp_session_id = cs.id)
         else (select count(*)::integer from public.registrations r
               where r.camp_session_id = cs.id and r.student_id is not null and private.registration_on_roster(r)) end,
    case when not cs.runs_own_registration and not v_enrops
         then (select (re.reported_at at time zone v_tz)::date from public.reported_enrollments re where re.camp_session_id = cs.id) end,
    (select array_agg(i.first_name || ' ' || i.last_name order by i.first_name, i.last_name)
       from public.camp_assignments ca
       join public.instructors i on i.id = ca.instructor_id and i.organization_id = v_org and i.is_active
      where ca.camp_session_id = cs.id and ca.organization_id = v_org and ca.status = 'confirmed')
  from public.camp_sessions cs
  join public.program_locations pl on pl.id = cs.location_id
  where pl.partner_id = p_partner_id
    and (v_sites is null or pl.id = any(v_sites))
    and cs.organization_id = v_org
    and cs.status in ('active', 'cancelled')
    and coalesce(cs.ends_on, v_today) >= v_today;
end;
$$;
revoke all on function public.partner_portal_classes(uuid) from public, anon;
grant execute on function public.partner_portal_classes(uuid) to authenticated;
