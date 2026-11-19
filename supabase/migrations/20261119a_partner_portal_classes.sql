-- Partner portal step 2: the classes at a partner's sites, with enrolled / max
-- and a roster the partner can open (Stacey Allington, City of Vancouver,
-- 2026-11-09: "will it run?" emails every week). Jessica 2026-11-19: show the
-- count as 5/18; the provider has to enter this information; Vancouver does
-- not register students.
--
-- WHERE EACH COUNT COMES FROM - one rule, decided per class, from config that
-- already exists (never per tenant):
--   programs/camp_sessions.runs_own_registration = true -> 'partner': the
--       partner registers families, enrops has no count and no roster.
--   organizations.uses_enrops_registration = false     -> 'provider': the
--       provider registers somewhere else and TYPES the count
--       (reported_enrollments, below), shown with its as-of date. No roster.
--   otherwise                                          -> 'enrops': live, and
--       the count IS the roster length, both read through
--       private.registration_on_roster().
--
-- private.registration_on_roster() is the SQL copy of src/lib/rosterOrder.js
-- isOnRoster() plus email-program-roster's `cancelled_at is null`. It is the
-- first SQL spelling of the roster rule (registration_is_enrolled drops a
-- clearing bank transfer; program_seat_counts counts checkouts in flight, which
-- are held seats, not enrolled children). src/lib/partnerClasses.test.mjs pins
-- the two together. Change one, change both.
--
-- WHO MAY READ: exactly the partner_portal_instructors gate. The provider's
-- owner/admin sees every site; a partner login sees only its grant's sites
-- (partner_access_sites); anyone else gets nothing. The gate lives once in
-- private.partner_portal_scope() for both new functions.
--
-- WHAT A ROSTER CARRIES: only what the emailed roster PDF already prints to
-- partners - student name, grade, homeroom, dismissal. Never a parent, a
-- contact, a birthdate or who may collect the child. A partner opening a roster
-- is written to audit_events ('roster_opened'), inside the read, so the read
-- and the log cannot come apart.

-- ---------------------------------------------------------------------------
-- 1. The roster rule, once in SQL.
create or replace function private.registration_on_roster(r public.registrations)
returns boolean
language sql
immutable
set search_path to ''
as $$
  select r.cancelled_at is null and (
    r.payment_status = 'paid'
    or r.status = 'confirmed'
    or r.ach_payment_state = 'processing'
  );
$$;
revoke all on function private.registration_on_roster(public.registrations) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. A count the provider types, for a class it registers outside enrops.
create table public.reported_enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  program_id uuid unique references public.programs(id) on delete cascade,
  camp_session_id uuid unique references public.camp_sessions(id) on delete cascade,
  enrolled integer not null check (enrolled >= 0 and enrolled <= 10000),
  reported_at timestamptz not null default now(),
  reported_by uuid,
  constraint reported_enrollments_one_class check ((program_id is null) <> (camp_session_id is null))
);
alter table public.reported_enrollments enable row level security;
-- No client grants: read through partner_portal_classes, written through
-- set_reported_enrollment. New tables get no automatic grants since 2026-10-30.
revoke all on table public.reported_enrollments from public, anon, authenticated;
grant all on table public.reported_enrollments to service_role;

-- ---------------------------------------------------------------------------
-- 3. The access gate, once.
create or replace function private.partner_portal_scope(p_partner_id uuid)
returns table(organization_id uuid, site_ids uuid[], allowed boolean, is_provider_admin boolean)
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_org uuid;
begin
  select p.organization_id into v_org from public.partners p where p.id = p_partner_id;
  if v_org is null then
    return query select null::uuid, null::uuid[], false, false;
    return;
  end if;
  if public.can_admin_org(v_org) then
    return query select v_org, null::uuid[], true, true;
  elsif exists (select 1 from private.current_partner_access() a where a.partner_id = p_partner_id) then
    return query select v_org, private.partner_access_sites(p_partner_id), true, false;
  else
    return query select v_org, null::uuid[], false, false;
  end if;
end;
$$;
revoke all on function private.partner_portal_scope(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The classes.
create or replace function public.partner_portal_classes(p_partner_id uuid)
returns table(
  kind text, class_id uuid, title text, site text,
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
               where r.program_id = pr.id and private.registration_on_roster(r)) end,
    case when not pr.runs_own_registration and not v_enrops
         then (select (re.reported_at at time zone v_tz)::date from public.reported_enrollments re where re.program_id = pr.id) end,
    (select array_agg(i.first_name || ' ' || i.last_name order by i.first_name, i.last_name)
       from public.program_assignments pa
       join public.instructors i on i.id = pa.instructor_id and i.organization_id = v_org
      where pa.program_id = pr.id and pa.organization_id = v_org and pa.status = 'confirmed')
  from progs pr
  where coalesce(pr.dates[array_length(pr.dates, 1)], pr.end_date, pr.first_session_date, v_today) >= v_today

  union all

  select
    'camp'::text,
    cs.id,
    cs.curriculum_name,
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
               where r.camp_session_id = cs.id and private.registration_on_roster(r)) end,
    case when not cs.runs_own_registration and not v_enrops
         then (select (re.reported_at at time zone v_tz)::date from public.reported_enrollments re where re.camp_session_id = cs.id) end,
    (select array_agg(i.first_name || ' ' || i.last_name order by i.first_name, i.last_name)
       from public.camp_assignments ca
       join public.instructors i on i.id = ca.instructor_id and i.organization_id = v_org
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

-- ---------------------------------------------------------------------------
-- 5. One class's roster. VOLATILE: a partner's read is logged in the same call.
create or replace function public.partner_portal_class_roster(p_partner_id uuid, p_kind text, p_class_id uuid)
returns table(row_key uuid, registered_at timestamptz, first_name text, last_name text, grade integer,
              homeroom text, dismissal_method text, aftercare_provider text)
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_org uuid;
  v_sites uuid[];
  v_ok boolean;
  v_admin boolean;
  v_enrops boolean;
  v_found boolean;
begin
  if p_kind not in ('class', 'camp') then
    return;
  end if;
  select s.organization_id, s.site_ids, s.allowed, s.is_provider_admin into v_org, v_sites, v_ok, v_admin
  from private.partner_portal_scope(p_partner_id) s;
  if not coalesce(v_ok, false) then
    return;
  end if;
  select coalesce(o.uses_enrops_registration, true) into v_enrops from public.organizations o where o.id = v_org;
  if not v_enrops then
    return;  -- the provider registers elsewhere: enrops holds no roster for it
  end if;

  -- The class must be at one of THIS login's sites, of this provider, live in
  -- enrops, and not cancelled. Anything else returns nothing.
  if p_kind = 'class' then
    select true into v_found
    from public.programs pr
    join public.program_locations pl on pl.id = pr.program_location_id
    where pr.id = p_class_id and pl.partner_id = p_partner_id
      and (v_sites is null or pl.id = any(v_sites))
      and pr.organization_id = v_org and pr.status = 'open'
      and coalesce(pr.runs_own_registration, false) = false;
  else
    select true into v_found
    from public.camp_sessions cs
    join public.program_locations pl on pl.id = cs.location_id
    where cs.id = p_class_id and pl.partner_id = p_partner_id
      and (v_sites is null or pl.id = any(v_sites))
      and cs.organization_id = v_org and cs.status = 'active'
      and coalesce(cs.runs_own_registration, false) = false;
  end if;
  if not coalesce(v_found, false) then
    return;
  end if;

  if not v_admin then
    insert into public.audit_events (organization_id, partner_id, actor_user_id, actor_role, action, subject_type, subject_id)
    values (v_org, p_partner_id, auth.uid(), 'partner', 'roster_opened',
            case when p_kind = 'class' then 'program' else 'camp_session' end, p_class_id);
  end if;

  return query
  select r.id, r.registered_at, st.first_name, st.last_name, st.grade, st.homeroom_teacher,
         st.dismissal_method, st.aftercare_provider
  from public.registrations r
  join public.students st on st.id = r.student_id
  where (case when p_kind = 'class' then r.program_id else r.camp_session_id end) = p_class_id
    and private.registration_on_roster(r);
end;
$$;
revoke all on function public.partner_portal_class_roster(uuid, text, uuid) from public, anon;
grant execute on function public.partner_portal_class_roster(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The provider types a count. Owner/admin of the class's provider only, and
-- only where the count really is theirs to type ('provider' source).
create or replace function public.set_reported_enrollment(p_kind text, p_class_id uuid, p_enrolled integer)
returns boolean
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_org uuid;
  v_partner uuid;
  v_own boolean;
  v_before integer;
begin
  if p_kind not in ('class', 'camp') or p_enrolled is null or p_enrolled < 0 or p_enrolled > 10000 then
    return false;
  end if;
  if p_kind = 'class' then
    select pr.organization_id, pl.partner_id, coalesce(pr.runs_own_registration, false)
      into v_org, v_partner, v_own
    from public.programs pr join public.program_locations pl on pl.id = pr.program_location_id
    where pr.id = p_class_id;
  else
    select cs.organization_id, pl.partner_id, coalesce(cs.runs_own_registration, false)
      into v_org, v_partner, v_own
    from public.camp_sessions cs join public.program_locations pl on pl.id = cs.location_id
    where cs.id = p_class_id;
  end if;
  if v_org is null or not public.can_admin_org(v_org) or v_own then
    return false;
  end if;
  if exists (select 1 from public.organizations o where o.id = v_org and coalesce(o.uses_enrops_registration, true)) then
    return false;  -- enrops counts this class itself; a typed number would contradict the roster
  end if;

  select re.enrolled into v_before from public.reported_enrollments re
  where (p_kind = 'class' and re.program_id = p_class_id) or (p_kind = 'camp' and re.camp_session_id = p_class_id);

  if p_kind = 'class' then
    insert into public.reported_enrollments (organization_id, program_id, enrolled, reported_at, reported_by)
    values (v_org, p_class_id, p_enrolled, now(), auth.uid())
    on conflict (program_id) do update set enrolled = excluded.enrolled, reported_at = excluded.reported_at, reported_by = excluded.reported_by;
  else
    insert into public.reported_enrollments (organization_id, camp_session_id, enrolled, reported_at, reported_by)
    values (v_org, p_class_id, p_enrolled, now(), auth.uid())
    on conflict (camp_session_id) do update set enrolled = excluded.enrolled, reported_at = excluded.reported_at, reported_by = excluded.reported_by;
  end if;

  insert into public.audit_events (organization_id, partner_id, actor_user_id, actor_role, action, subject_type, subject_id, before, after)
  values (v_org, v_partner, auth.uid(), 'provider_admin', 'reported_enrollment_changed',
          case when p_kind = 'class' then 'program' else 'camp_session' end, p_class_id,
          case when v_before is null then null else jsonb_build_object('enrolled', v_before) end,
          jsonb_build_object('enrolled', p_enrolled));
  return true;
end;
$$;
revoke all on function public.set_reported_enrollment(text, uuid, integer) from public, anon;
grant execute on function public.set_reported_enrollment(text, uuid, integer) to authenticated;
