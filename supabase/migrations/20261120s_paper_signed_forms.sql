-- A form signed on paper, recorded by the provider (Jessica 2026-11-20, "Build
-- it"). The code of conduct, mandatory reporter acknowledgment and contractor
-- agreement could only be signed by the instructor during enrops onboarding,
-- so an instructor who signed one on paper showed "Expired or Missing" to every
-- partner and the provider had no way to fix it.
--
-- EXTEND, NOT A NEW TABLE. contractor_acknowledgments is where every reader
-- already looks for a signed form (partner_portal_instructors and the
-- instructor's Documents panel). A paper record is one more row there, marked
-- source = 'paper' with document_version 'paper', so the unique key
-- (instructor, document, version) keeps exactly one paper record per form and
-- re-recording corrects its date. A paper contractor agreement goes here too:
-- contractor_agreements is the e-signed legal record (typed signature, text
-- snapshot), and a provider must never fabricate one.
--
-- What a partner sees: the same date column as before, plus whether the
-- latest record is a paper one, so the line reads "signed on paper, entered by
-- <provider>" and never "signed by the instructor in enrops".
--
-- Paper records never complete onboarding and never gate assignment: nothing
-- that decides those reads this table (checked 2026-11-20, staging and repo).

begin;

alter table public.contractor_acknowledgments
  add column source text not null default 'enrops',
  add column recorded_by uuid;

alter table public.contractor_acknowledgments
  add constraint contractor_acknowledgments_source_check
    check (source in ('enrops', 'paper')),
  add constraint contractor_acknowledgments_paper_version_check
    check ((source = 'paper') = (document_version = 'paper'));

-- Record (or correct the date of) a form signed on paper. Owner/admin of the
-- instructor's provider only.
create or replace function public.record_paper_signature(
  p_instructor_id uuid, p_document_id text, p_signed_on date)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_org uuid;
  v_today date;
  v_before timestamptz;
begin
  select i.organization_id into v_org from public.instructors i where i.id = p_instructor_id;
  if v_org is null or not public.can_admin_org(v_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_document_id is null or p_document_id not in ('code_of_conduct', 'mandatory_reporter_ack', 'contractor_agreement') then
    raise exception 'unknown form' using errcode = '22023';
  end if;
  v_today := (now() at time zone coalesce(
    (select o.timezone from public.organizations o where o.id = v_org), 'America/Los_Angeles'))::date;
  if p_signed_on is null or p_signed_on > v_today or p_signed_on < date '2000-01-01' then
    raise exception 'the date signed must be a real date, not in the future' using errcode = '22023';
  end if;

  select k.acknowledged_at into v_before from public.contractor_acknowledgments k
  where k.instructor_id = p_instructor_id and k.document_id = p_document_id and k.document_version = 'paper';

  -- Noon UTC, so ::date reads back the date on the paper in every reader.
  insert into public.contractor_acknowledgments
    (instructor_id, organization_id, document_id, document_version, acknowledged_at, source, recorded_by)
  values
    (p_instructor_id, v_org, p_document_id, 'paper', (p_signed_on + time '12:00') at time zone 'UTC', 'paper', auth.uid())
  on conflict (instructor_id, document_id, document_version)
  do update set acknowledged_at = excluded.acknowledged_at, recorded_by = excluded.recorded_by;

  insert into public.audit_events (organization_id, actor_user_id, actor_role, action, subject_type, subject_id, before, after)
  values (v_org, auth.uid(), 'provider_admin', 'paper_signature_recorded', 'instructor', p_instructor_id,
    case when v_before is null then null else jsonb_build_object('document_id', p_document_id, 'signed_on', (v_before at time zone 'UTC')::date) end,
    jsonb_build_object('document_id', p_document_id, 'signed_on', p_signed_on));
end;
$$;

-- Remove a paper record entered by mistake. Never touches an e-signed row.
create or replace function public.remove_paper_signature(p_instructor_id uuid, p_document_id text)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_org uuid;
  v_before timestamptz;
begin
  select i.organization_id into v_org from public.instructors i where i.id = p_instructor_id;
  if v_org is null or not public.can_admin_org(v_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.contractor_acknowledgments k
  where k.instructor_id = p_instructor_id and k.document_id = p_document_id
    and k.source = 'paper' and k.document_version = 'paper'
  returning k.acknowledged_at into v_before;
  if v_before is null then
    return;
  end if;
  insert into public.audit_events (organization_id, actor_user_id, actor_role, action, subject_type, subject_id, before, after)
  values (v_org, auth.uid(), 'provider_admin', 'paper_signature_removed', 'instructor', p_instructor_id,
    jsonb_build_object('document_id', p_document_id, 'signed_on', (v_before at time zone 'UTC')::date), null);
end;
$$;

revoke all on function public.record_paper_signature(uuid, text, date) from public, anon;
grant execute on function public.record_paper_signature(uuid, text, date) to authenticated;
revoke all on function public.remove_paper_signature(uuid, text) from public, anon;
grant execute on function public.remove_paper_signature(uuid, text) to authenticated;

-- partner_portal_instructors (20261030a) restated with three columns added at
-- the end: whether the latest record of each form is a paper one. The
-- contractor agreement's date is now the later of the e-signed agreement and
-- a paper one. Everything else is unchanged.
drop function public.partner_portal_instructors(uuid);

create function public.partner_portal_instructors(p_partner_id uuid)
 returns table(instructor_id uuid, first_name text, last_name text, sites text[], shared boolean, email text, phone text, background_check_completed_on date, background_check_expires_on date, background_check_status text, background_check_vendor text, background_check_as_of date, training_completed_on date, training_as_of date, code_of_conduct_on date, mandatory_reporter_on date, agreement_signed_on date, code_of_conduct_paper boolean, mandatory_reporter_paper boolean, agreement_paper boolean)
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_org uuid;
  v_today date;
  v_months integer;
  v_sites uuid[];  -- null = every site of the partner
begin
  select p.organization_id into v_org from public.partners p where p.id = p_partner_id;
  if v_org is null then
    return;
  end if;
  if public.can_admin_org(v_org) then
    v_sites := null;
  elsif exists (select 1 from private.current_partner_access() a where a.partner_id = p_partner_id) then
    v_sites := private.partner_access_sites(p_partner_id);
  else
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
      and (v_sites is null or pl.id = any(v_sites))
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
      and (v_sites is null or pl.id = any(v_sites))
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
    case when i.partner_sharing_agreed_at is null then 'in_review'
         when s.checkr_status in ('pending', 'invited', 'processing') then 'in_review'
         when s.checkr_status is distinct from 'clear' then 'missing'
         when s.background_check_completed_on is null then 'awaiting_date'
         when v_months = 0 then private.document_expiry_status(null, v_org)
         else private.document_expiry_status(
           (s.background_check_completed_on + make_interval(months => v_months))::date, v_org)
    end,
    case when i.partner_sharing_agreed_at is not null then s.background_check_vendor end,
    case when i.partner_sharing_agreed_at is not null then s.background_check_entered_at::date end,
    case when i.partner_sharing_agreed_at is not null then i.training_completed_on end,
    case when i.partner_sharing_agreed_at is not null then i.training_entered_at::date end,
    case when i.partner_sharing_agreed_at is not null then coc.at::date end,
    case when i.partner_sharing_agreed_at is not null then mr.at::date end,
    case when i.partner_sharing_agreed_at is not null then greatest(ag.at, agp.at)::date end,
    case when i.partner_sharing_agreed_at is not null then coalesce(coc.paper, false) end,
    case when i.partner_sharing_agreed_at is not null then coalesce(mr.paper, false) end,
    -- A tie goes to the e-signed agreement.
    case when i.partner_sharing_agreed_at is not null
      then agp.at is not null and (ag.at is null or agp.at > ag.at) end
  from people pp
  join public.instructors i on i.id = pp.instructor_id and i.organization_id = v_org
  left join public.contractor_onboarding_status s
    on s.instructor_id = i.id and s.organization_id = v_org
  -- The latest record of each form; on the same instant the e-signed one wins.
  left join lateral (
    select k.acknowledged_at as at, k.source = 'paper' as paper
    from public.contractor_acknowledgments k
    where k.instructor_id = i.id and k.organization_id = v_org and k.document_id = 'code_of_conduct'
    order by k.acknowledged_at desc, (k.source = 'paper') limit 1
  ) coc on true
  left join lateral (
    select k.acknowledged_at as at, k.source = 'paper' as paper
    from public.contractor_acknowledgments k
    where k.instructor_id = i.id and k.organization_id = v_org and k.document_id = 'mandatory_reporter_ack'
    order by k.acknowledged_at desc, (k.source = 'paper') limit 1
  ) mr on true
  left join lateral (
    select max(g.signed_at) as at from public.contractor_agreements g
    where g.instructor_id = i.id and g.organization_id = v_org
  ) ag on true
  left join lateral (
    select max(k.acknowledged_at) as at from public.contractor_acknowledgments k
    where k.instructor_id = i.id and k.organization_id = v_org
      and k.document_id = 'contractor_agreement' and k.source = 'paper'
  ) agp on true
  where i.is_active
  order by i.last_name, i.first_name;
end;
$function$;

revoke all on function public.partner_portal_instructors(uuid) from public, anon;
grant execute on function public.partner_portal_instructors(uuid) to authenticated, service_role;

commit;
