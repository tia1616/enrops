-- Partner portal: the rest of the Oct 30 list (Arielle's spec v3, Oct 19).
--
-- 1. Business license is its own document type, so the partner sees it as a
--    named item rather than under "Other".
-- 2. Insurance records whether the certificate names the partner as additional
--    insured (spec: "additional insured (yes or no)").
-- 3. Two partner roles, host_admin and host_viewer. On Oct 30 they see the same
--    thing; the difference arrives with decisions (Nov 6) and team management.
--    Chosen when access is given; to change it, remove and give access again.
-- 4. "As of" on every chip: when the provider last ENTERED each fact, stamped by
--    the database whenever the fact changes, never trusted from the client.
-- 5. audit_events: append-only. No role can update or delete a row (spec v3 §3:
--    "Enforce with database rules, not in the app"). Writes come only through
--    SECURITY DEFINER functions. First writers: a partner opening the portal
--    and opening a document (the view log Jessica approved 10/19).
-- 6. Partners can send feedback through the existing Share feedback widget:
--    the feedback insert policy admits a partner of that provider.
-- 7. partner_portal_instructors: spec v3's six chip words. A failed or
--    unfinished check reads "Expired or Missing" (never its own word); an
--    instructor who has not given permission reads "In review" with the
--    reason; returns the as-of dates.

-- 1 + 2 ---------------------------------------------------------------------
alter table public.provider_documents drop constraint if exists provider_documents_doc_type_check;
alter table public.provider_documents add constraint provider_documents_doc_type_check
  check (doc_type = any (array['insurance'::text, 'agreement'::text, 'business_license'::text, 'other'::text]));

alter table public.provider_documents
  add column if not exists additional_insured boolean;
comment on column public.provider_documents.additional_insured is
  'Insurance only: does the certificate name the partner as additional insured? NULL = not recorded.';

-- The view lists columns explicitly, so the new one must be added to it. Adding
-- a trailing column is allowed by CREATE OR REPLACE; security_invoker is then
-- set again explicitly, because OR REPLACE resets view options.
create or replace view public.provider_documents_with_status as
  select d.id, d.organization_id, d.partner_id, d.doc_type, d.title, d.received_on,
         d.effective_on, d.expires_on, d.storage_path, d.original_filename, d.insurer,
         d.policy_number, d.abuse_coverage, d.coverage_notes, d.created_by, d.created_at,
         d.updated_at,
         private.document_expiry_status(d.expires_on, d.organization_id) as expiry_status,
         d.additional_insured
  from public.provider_documents d;
alter view public.provider_documents_with_status set (security_invoker = on);

-- 3 -------------------------------------------------------------------------
alter table public.partner_portal_access
  add column if not exists role text not null default 'host_admin';
alter table public.partner_portal_access drop constraint if exists partner_portal_access_role_check;
alter table public.partner_portal_access add constraint partner_portal_access_role_check
  check (role in ('host_admin', 'host_viewer'));

-- 4 -------------------------------------------------------------------------
alter table public.contractor_onboarding_status
  add column if not exists background_check_entered_at timestamptz;
comment on column public.contractor_onboarding_status.background_check_entered_at is
  'When the background check result, date or company last changed. Set by trigger. Shown to partners as "as of".';

alter table public.instructors
  add column if not exists training_entered_at timestamptz;
comment on column public.instructors.training_entered_at is
  'When training_completed_on last changed. Set by trigger. Shown to partners as "as of".';

-- Existing results have no recorded entry time. updated_at is the closest
-- honest proxy: the row last changed then, so the fact was on file by then.
-- Runs BEFORE the stamping trigger exists: with the trigger in place this
-- UPDATE changes no result column, so the trigger would put the old NULL back.
update public.contractor_onboarding_status
   set background_check_entered_at = updated_at
 where background_check_entered_at is null
   and (background_check_completed_on is not null or checkr_status = 'clear');

create or replace function private.stamp_background_check_entered()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.background_check_completed_on is not null or new.checkr_status = 'clear' then
      new.background_check_entered_at := now();
    else
      new.background_check_entered_at := null;
    end if;
  elsif new.checkr_status is distinct from old.checkr_status
     or new.background_check_completed_on is distinct from old.background_check_completed_on
     or new.background_check_vendor is distinct from old.background_check_vendor then
    new.background_check_entered_at := now();
  else
    new.background_check_entered_at := old.background_check_entered_at;
  end if;
  return new;
end;
$$;
drop trigger if exists stamp_background_check_entered on public.contractor_onboarding_status;
create trigger stamp_background_check_entered
  before insert or update on public.contractor_onboarding_status
  for each row execute function private.stamp_background_check_entered();

update public.instructors
   set training_entered_at = coalesce(updated_at, now())
 where training_entered_at is null
   and training_completed_on is not null;

create or replace function private.stamp_training_entered()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.training_entered_at := case when new.training_completed_on is not null then now() end;
  elsif new.training_completed_on is distinct from old.training_completed_on then
    new.training_entered_at := now();
  else
    new.training_entered_at := old.training_entered_at;
  end if;
  return new;
end;
$$;
drop trigger if exists stamp_training_entered on public.instructors;
create trigger stamp_training_entered
  before insert or update on public.instructors
  for each row execute function private.stamp_training_entered();


-- 5 -------------------------------------------------------------------------
create table if not exists public.audit_events (
  id              uuid primary key default gen_random_uuid(),
  occurred_at     timestamptz not null default now(),
  -- No cascade and no set-null: either would be an UPDATE or DELETE of an audit
  -- row, which the append-only trigger refuses. A partner or provider with
  -- audit history therefore cannot be hard-deleted, which is the point.
  organization_id uuid not null references public.organizations(id),
  partner_id      uuid references public.partners(id),
  actor_user_id   uuid,
  actor_role      text not null,
  action          text not null,
  subject_type    text,
  subject_id      uuid,
  before          jsonb,
  after           jsonb
);
create index if not exists audit_events_org_time on public.audit_events (organization_id, occurred_at desc);

alter table public.audit_events enable row level security;
revoke all on public.audit_events from anon;
revoke insert, update, delete, truncate on public.audit_events from authenticated;
grant select on public.audit_events to authenticated;

drop policy if exists audit_events_admin_select on public.audit_events;
create policy audit_events_admin_select on public.audit_events
  for select to authenticated
  using (public.can_admin_org(organization_id));

-- Append-only for EVERY role, including the table owner: a row can be added,
-- never changed or removed. (Only a superuser disabling the trigger gets past.)
create or replace function private.refuse_audit_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_events is append-only' using errcode = 'AU001';
end;
$$;
drop trigger if exists audit_events_append_only on public.audit_events;
create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function private.refuse_audit_change();
drop trigger if exists audit_events_no_truncate on public.audit_events;
create trigger audit_events_no_truncate
  before truncate on public.audit_events
  for each statement execute function private.refuse_audit_change();

-- A partner's own activity. The partner must hold access to p_partner_id; a
-- document must be one that partner can see. Returns false (nothing written)
-- otherwise, so a bad call is a no-op rather than an error the page shows.
create or replace function public.log_partner_portal_event(
  p_partner_id uuid,
  p_action text,
  p_document_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if p_action not in ('portal_viewed', 'document_opened') then
    return false;
  end if;
  select a.organization_id into v_org
  from private.current_partner_access() a
  where a.partner_id = p_partner_id;
  if v_org is null then
    return false;
  end if;
  if p_action = 'document_opened' then
    if p_document_id is null or not exists (
      select 1 from public.provider_documents d
      where d.id = p_document_id
        and d.organization_id = v_org
        and (d.partner_id is null or d.partner_id = p_partner_id)
    ) then
      return false;
    end if;
  end if;
  insert into public.audit_events (organization_id, partner_id, actor_user_id, actor_role, action, subject_type, subject_id)
  values (v_org, p_partner_id, auth.uid(), 'partner', p_action,
          case when p_action = 'document_opened' then 'provider_document' end,
          p_document_id);
  return true;
end;
$$;
revoke all on function public.log_partner_portal_event(uuid, text, uuid) from public;
revoke all on function public.log_partner_portal_event(uuid, text, uuid) from anon;
grant execute on function public.log_partner_portal_event(uuid, text, uuid) to authenticated;
revoke all on function private.refuse_audit_change() from public;
revoke all on function private.stamp_background_check_entered() from public;
revoke all on function private.stamp_training_entered() from public;

-- 6 -------------------------------------------------------------------------
drop policy if exists partners_insert_feedback on public.feedback;
create policy partners_insert_feedback on public.feedback
  for insert to authenticated
  with check (
    exists (select 1 from private.current_partner_access() a where a.organization_id = feedback.organization_id)
    and auth_user_id = auth.uid()
    and (user_email is null or user_email = auth.email())
  );

-- 7 -------------------------------------------------------------------------
drop function if exists public.partner_portal_instructors(uuid);
create function public.partner_portal_instructors(p_partner_id uuid)
returns table (
  instructor_id uuid, first_name text, last_name text, sites text[], shared boolean,
  email text, phone text, background_check_completed_on date, background_check_expires_on date,
  background_check_status text, background_check_vendor text, background_check_as_of date,
  training_completed_on date, training_as_of date,
  code_of_conduct_on date, mandatory_reporter_on date, agreement_signed_on date
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
  select p.organization_id into v_org from public.partners p where p.id = p_partner_id;
  if v_org is null then
    return;
  end if;
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
    -- Spec v3 chips. Not given permission: in_review (the page says why).
    -- Cleared = checkr_status 'clear', the onboarding gate's flag. Started but
    -- not finished: in_review. Anything else that is not clear (never started,
    -- or a result that is not clear): missing, shown as "Expired or Missing" so
    -- a failed check never gets its own word. Cleared with no completed date
    -- cannot have a renewal date: in_review until the date is entered.
    case when i.partner_sharing_agreed_at is null then 'in_review'
         when s.checkr_status in ('pending', 'invited', 'processing') then 'in_review'
         when s.checkr_status is distinct from 'clear' then 'missing'
         when s.background_check_completed_on is null then 'in_review'
         when v_months = 0 then private.document_expiry_status(null, v_org)
         else private.document_expiry_status(
           (s.background_check_completed_on + make_interval(months => v_months))::date, v_org)
    end,
    case when i.partner_sharing_agreed_at is not null then s.background_check_vendor end,
    case when i.partner_sharing_agreed_at is not null then s.background_check_entered_at::date end,
    case when i.partner_sharing_agreed_at is not null then i.training_completed_on end,
    case when i.partner_sharing_agreed_at is not null then i.training_entered_at::date end,
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
