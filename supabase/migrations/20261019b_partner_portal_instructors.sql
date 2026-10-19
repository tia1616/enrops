-- Partner portal, instructor checklist (chunk 3a).
--
-- A partner sees the provider's instructors at THAT partner's sites: full name,
-- contact info, background check status and dates, who ran the check, training
-- date, code of conduct, mandatory reporter and agreement dates. Never the
-- background check report.
--
-- WHO IS "AT THEIR SITES" (Jessica 2026-10-19: no "taught recently"; she
-- assigns instructors before partners look). A CONFIRMED assignment on a class
-- or camp that is not cancelled and not over, at a site whose partner_id is
-- this partner. Classes: program_assignments -> programs (winter camps are
-- programs too). Summer camps: camp_assignments -> camp_sessions. "Not over" =
-- the last derived session date is today or later, or no dates yet (upcoming).
-- Every assigned class on prod had derivable dates when this was written.
--
-- SHARING NEEDS THE INSTRUCTOR'S PERMISSION (20261019a). Without it the partner
-- sees the name and sites only, with every detail NULL, and the portal says
-- permission is pending.
--
-- BACKGROUND CHECK EXPIRY is the provider's rule, not ours:
-- organizations.background_check_config ->> 'valid_months' (Settings ->
-- Background checks). Absent means 12, the industry norm and Arielle's spec.
-- 0 means checks never expire. The status words come from the SAME function
-- documents use, private.document_expiry_status(), so "Expiring in 30 days"
-- means one thing everywhere. No completed date = 'missing'.

alter table public.contractor_onboarding_status
  add column if not exists background_check_vendor text;
comment on column public.contractor_onboarding_status.background_check_vendor is
  'Company that ran this check (e.g. Yardstik, Checkr), as entered by the provider. Shown to partners as provenance. NULL = not recorded.';

alter table public.instructors
  add column if not exists training_completed_on date;
comment on column public.instructors.training_completed_on is
  'Date the provider trained this instructor (entered by the provider). Shown to partners. Separate from video-course completions in instructor_training_completions.';

create or replace function private.background_check_valid_months(p_org uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when (o.background_check_config ->> 'valid_months') ~ '^\d{1,3}$'
      then (o.background_check_config ->> 'valid_months')::integer
    else 12
  end
  from public.organizations o
  where o.id = p_org;
$$;
revoke all on function private.background_check_valid_months(uuid) from public;

create or replace function public.partner_portal_instructors(p_partner_id uuid)
returns table (
  instructor_id uuid,
  first_name text,
  last_name text,
  sites text[],
  shared boolean,
  email text,
  phone text,
  background_check_completed_on date,
  background_check_expires_on date,
  background_check_status text,
  background_check_vendor text,
  training_completed_on date,
  code_of_conduct_on date,
  mandatory_reporter_on date,
  agreement_signed_on date
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_today date;
  v_months integer;
begin
  select p.organization_id into v_org
  from public.partners p
  where p.id = p_partner_id;
  if v_org is null then
    return;
  end if;

  -- A partner login for this partner, or the provider's own owner/admin
  -- (so the provider can see exactly what the partner sees). Anyone else: nothing.
  if not exists (select 1 from private.current_partner_access() a where a.partner_id = p_partner_id)
     and not public.can_admin_org(v_org) then
    return;
  end if;

  v_today := (now() at time zone coalesce(
    (select o.timezone from public.organizations o where o.id = v_org), 'America/Los_Angeles'))::date;
  v_months := private.background_check_valid_months(v_org);

  return query
  with assigned as (
    select pa.instructor_id, pl.name as site
    from public.program_assignments pa
    join public.programs pr on pr.id = pa.program_id
    join public.program_locations pl on pl.id = pr.program_location_id
    where pl.partner_id = p_partner_id
      and pa.organization_id = v_org
      and pa.status = 'confirmed'
      and coalesce(pr.status, '') <> 'cancelled'
      and coalesce(
            (select max(d) from unnest(public.derive_program_session_dates(pr.id)) d),
            v_today) >= v_today
    union
    select ca.instructor_id, pl.name
    from public.camp_assignments ca
    join public.camp_sessions cs on cs.id = ca.camp_session_id
    join public.program_locations pl on pl.id = cs.location_id
    where pl.partner_id = p_partner_id
      and ca.organization_id = v_org
      and ca.status = 'confirmed'
      and coalesce(cs.status, '') <> 'cancelled'
      and coalesce(cs.ends_on, v_today) >= v_today
  ),
  people as (
    select a.instructor_id, array_agg(distinct a.site order by a.site) as sites
    from assigned a
    group by a.instructor_id
  )
  select
    i.id,
    i.first_name,
    i.last_name,
    pp.sites,
    (i.partner_sharing_agreed_at is not null),
    case when i.partner_sharing_agreed_at is not null then i.email end,
    case when i.partner_sharing_agreed_at is not null then i.phone end,
    case when i.partner_sharing_agreed_at is not null and s.checkr_status = 'clear'
      then s.background_check_completed_on end,
    case when i.partner_sharing_agreed_at is not null and s.checkr_status = 'clear' and v_months > 0
      then (s.background_check_completed_on + make_interval(months => v_months))::date end,
    -- CLEARED IS checkr_status = 'clear', the same flag the onboarding gate
    -- (gateCheck.ts) and the provider's instructor screen use, whatever the
    -- vendor. Not cleared and never started = missing; started but not clear =
    -- in review. Cleared with no completed date (1 J2S row on prod 10/19) cannot
    -- have a renewal date, so it says so rather than guessing one.
    case when i.partner_sharing_agreed_at is null then null
         when s.checkr_status is null or s.checkr_status = 'not_started' then 'missing'
         when s.checkr_status <> 'clear' then 'in_review'
         when s.background_check_completed_on is null then 'date_missing'
         when v_months = 0 then private.document_expiry_status(null, v_org)
         else private.document_expiry_status(
           (s.background_check_completed_on + make_interval(months => v_months))::date, v_org)
    end,
    case when i.partner_sharing_agreed_at is not null then s.background_check_vendor end,
    case when i.partner_sharing_agreed_at is not null then i.training_completed_on end,
    case when i.partner_sharing_agreed_at is not null then (
      select max(k.acknowledged_at)::date from public.contractor_acknowledgments k
      where k.instructor_id = i.id and k.organization_id = v_org and k.document_id = 'code_of_conduct') end,
    case when i.partner_sharing_agreed_at is not null then (
      select max(k.acknowledged_at)::date from public.contractor_acknowledgments k
      where k.instructor_id = i.id and k.organization_id = v_org and k.document_id = 'mandatory_reporter_ack') end,
    case when i.partner_sharing_agreed_at is not null then (
      select max(g.signed_at)::date from public.contractor_agreements g
      where g.instructor_id = i.id and g.organization_id = v_org) end
  from people pp
  join public.instructors i on i.id = pp.instructor_id and i.organization_id = v_org
  left join public.contractor_onboarding_status s
    on s.instructor_id = i.id and s.organization_id = v_org
  where i.is_active
  order by i.last_name, i.first_name;
end;
$$;

revoke all on function public.partner_portal_instructors(uuid) from public;
revoke all on function public.partner_portal_instructors(uuid) from anon;
grant execute on function public.partner_portal_instructors(uuid) to authenticated;

-- Provider-side write for the check's vendor on an existing record (the upload
-- form sends it with a new report). Owner/admin of the instructor's org only.
create or replace function public.set_background_check_vendor(p_instructor_id uuid, p_vendor text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select i.organization_id into v_org from public.instructors i where i.id = p_instructor_id;
  if v_org is null or not public.can_admin_org(v_org) then
    return false;
  end if;
  update public.contractor_onboarding_status
     set background_check_vendor = nullif(left(btrim(coalesce(p_vendor, '')), 80), ''),
         updated_at = now()
   where instructor_id = p_instructor_id
     and organization_id = v_org;
  return found;
end;
$$;
revoke all on function public.set_background_check_vendor(uuid, text) from public;
revoke all on function public.set_background_check_vendor(uuid, text) from anon;
grant execute on function public.set_background_check_vendor(uuid, text) to authenticated;
