-- 20261125t: what a partner needs from us at the end of a term, in the portal
-- both sides already use (Jessica 2026-11-25: "think about this simply - what
-- info do they need?").
--
-- From the Payments & Receivables sheet ("Partnership Invoicing" tab) and the
-- SOP, partners ask for three things when we invoice or pay them: the roster
-- (or a count), which sessions actually happened (OES "list each individual
-- date we had class", Impact NW "note any missed sessions", Camas prorates
-- short classes, Catlin bills per session), and for revenue splits what
-- families actually paid (Happy Valley: "their 10% is of what families
-- actually paid, after early bird, promo codes and discounts").
-- The portal already shows the roster. This adds the other two, and keeps a
-- finished class listed long enough to invoice it.
--
-- 1. partner_portal_classes: a class whose last date has passed stays listed
--    for 60 days, as status 'finished' (it used to vanish the day after its
--    last session, before anyone could invoice it). Every other line is the
--    live body (md5 59406235faa1df75b4d5479fe9233223 on staging AND prod
--    2026-11-25, which is 20261119q's text). Return type unchanged, so
--    CREATE OR REPLACE keeps the grants.
-- 2. partner_portal_class_summary: for one class the caller may see (the same
--    scope and class checks as partner_portal_class_roster): each session date
--    as held / cancelled / upcoming / not confirmed, and - only for a class
--    families registered for through enrops - how many children were paid for and the
--    total they paid: the class amount (or the instalments actually collected)
--    minus refunds that went through. Unpaid, cancelled and off-roster
--    registrations are not counted. Never the enrops service fee.
--    Proven on prod 2026-11-25 before writing: Happy Valley Fall Super Mario =
--    6 children paid for, $1,686 (= the hand-worked AP row), 8 of 8 sessions held.

create or replace function public.partner_portal_classes(p_partner_id uuid)
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
    case when pr.status in ('cancelled', 'draft') then pr.status
         -- NEW (20261125t): past its last date = finished, kept for invoicing.
         when coalesce(pr.dates[array_length(pr.dates, 1)], pr.end_date, pr.first_session_date, v_today) < v_today then 'finished'
         else 'open' end,
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
  -- NEW (20261125t): finished classes stay listed for 60 days (was: not ended).
  where coalesce(pr.dates[array_length(pr.dates, 1)], pr.end_date, pr.first_session_date, v_today) >= v_today - 60

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
    case when cs.status = 'cancelled' then 'cancelled'
         -- NEW (20261125t)
         when coalesce(cs.ends_on, v_today) < v_today then 'finished'
         else 'open' end,
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
    -- NEW (20261125t): finished camps stay listed for 60 days.
    and coalesce(cs.ends_on, v_today) >= v_today - 60;
end;
$$;
revoke all on function public.partner_portal_classes(uuid) from public, anon;
grant execute on function public.partner_portal_classes(uuid) to authenticated;

create or replace function public.partner_portal_class_summary(p_partner_id uuid, p_kind text, p_class_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_org uuid;
  v_sites uuid[];
  v_ok boolean;
  v_enrops boolean;
  v_tz text;
  v_today date;
  v_found boolean;
  v_own boolean;
  v_dates date[];
  v_sessions jsonb;
  v_money jsonb := null;
begin
  if p_kind not in ('class', 'camp') then
    return null;
  end if;
  -- Who may see what: the roster's scope (partner_portal_class_roster).
  select s.organization_id, s.site_ids, s.allowed into v_org, v_sites, v_ok
  from private.partner_portal_scope(p_partner_id) s;
  if not coalesce(v_ok, false) then
    return null;
  end if;
  select coalesce(o.uses_enrops_registration, true), coalesce(o.timezone, 'America/Los_Angeles')
    into v_enrops, v_tz
  from public.organizations o where o.id = v_org;
  v_today := (now() at time zone v_tz)::date;

  -- The class must be at one of THIS login's sites, of this provider, and live
  -- (not draft, not cancelled). Anything else returns nothing.
  if p_kind = 'class' then
    select true, coalesce(pr.runs_own_registration, false),
           (select array_agg(d order by d) from unnest(public.derive_program_session_dates(pr.id)) d)
      into v_found, v_own, v_dates
    from public.programs pr
    join public.program_locations pl on pl.id = pr.program_location_id
    where pr.id = p_class_id and pl.partner_id = p_partner_id
      and (v_sites is null or pl.id = any(v_sites))
      and pr.organization_id = v_org and pr.status = 'open';
  else
    select true, coalesce(cs.runs_own_registration, false),
           (select array_agg(g::date order by g)
              from generate_series(cs.starts_on, coalesce(cs.ends_on, cs.starts_on), interval '1 day') g
             where (coalesce(array_length(cs.class_days, 1), 0) = 0
                or lower(to_char(g, 'FMDay')) = any (select lower(btrim(x)) from unnest(cs.class_days::text[]) x))
               -- The site's own closures apply to camps too (as in
               -- derive_program_session_dates); the district calendar does not.
               and not (g::date = any (coalesce(pl.closure_dates, '{}'::date[]))))
      into v_found, v_own, v_dates
    from public.camp_sessions cs
    join public.program_locations pl on pl.id = cs.location_id
    where cs.id = p_class_id and pl.partner_id = p_partner_id
      and (v_sites is null or pl.id = any(v_sites))
      and cs.organization_id = v_org and cs.status = 'active';
  end if;
  if not coalesce(v_found, false) then
    return null;
  end if;

  -- Each scheduled date: held (an instructor confirmed it), upcoming, or not
  -- confirmed (past, no confirmation). Plus cancelled sessions (skips that
  -- were not restored), which the schedule no longer lists.
  select coalesce(jsonb_agg(jsonb_build_object('date', x.d, 'status', x.st) order by x.d), '[]'::jsonb)
    into v_sessions
  from (
    select d,
           case when exists (
                  select 1 from public.session_delivery_confirmations c
                  where c.session_date = d
                    and ((p_kind = 'class' and c.program_id = p_class_id)
                      or (p_kind = 'camp' and c.camp_session_id = p_class_id)))
                then 'held'
                when d >= v_today then 'upcoming'
                else 'not_confirmed' end as st
    from unnest(coalesce(v_dates, '{}'::date[])) d
    union all
    select k.session_date, 'cancelled'
    from public.program_session_skips k
    where p_kind = 'class' and k.program_id = p_class_id and k.restored_at is null
      and not (k.session_date = any (coalesce(v_dates, '{}'::date[])))
  ) x;

  -- What families actually paid: only where families registered through enrops.
  if v_enrops and not v_own then
    select jsonb_build_object('children', count(*) filter (where t.collected > 0),
                              'paid_cents', coalesce(sum(t.collected), 0))
      into v_money
    from (
      select greatest(
               case when exists (select 1 from public.installments i where i.registration_id = r.id)
                    then (select coalesce(sum(i.amount_cents), 0) from public.installments i
                          where i.registration_id = r.id and i.status = 'paid')
                    when r.payment_status in ('paid', 'partial') then coalesce(r.amount_cents, 0)
                    else 0 end
               - (select coalesce(sum(f.amount_cents), 0) from public.refunds f
                  where f.registration_id = r.id and f.status = 'succeeded'),
               0) as collected
      from public.registrations r
      where ((p_kind = 'class' and r.program_id = p_class_id)
          or (p_kind = 'camp' and r.camp_session_id = p_class_id))
        and r.student_id is not null and private.registration_on_roster(r)
    ) t;
  end if;

  return jsonb_build_object('sessions', v_sessions, 'money', v_money);
end;
$$;
revoke all on function public.partner_portal_class_summary(uuid, text, uuid) from public, anon;
grant execute on function public.partner_portal_class_summary(uuid, text, uuid) to authenticated;
