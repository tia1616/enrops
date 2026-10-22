-- Partner-sharing wording v2, and a way for the instructor to stop sharing.
--
-- v2 is Arielle's wording (roadmap thread, 2026-10-21): v1 plus the screening
-- expiry and screening company from spec v3, and "I can stop this at any time."
-- That last sentence is a promise, so this migration ships the thing it
-- promises in the same pass: public.stop_partner_sharing().
--
-- v1 AGREEMENTS STAY VALID. They agreed to v1's words and the column says so.
-- Only NEW agreements are taken at v2; agree_partner_sharing() now refuses v1.
--
-- STOPPING CLEARS THE AGREEMENT, it does not store a "declined" (see 20261019a:
-- this permission is required, not a yes/no). partner_portal_instructors()
-- already reads a NULL partner_sharing_agreed_at as in_review, "Waiting on this
-- instructor's consent", and hides contact info and check details. So the
-- partner side needs no change and stops showing the record immediately.
--
-- THE HISTORY LIVES IN audit_events. Clearing the columns would otherwise erase
-- when they first agreed and to which words. Both functions append a row
-- (actor_role 'instructor'). The partner activity list filters on its own two
-- actions, so these rows never show there.
--
-- partner_sharing_stopped_at is for the admin screen only: "Stopped sharing"
-- reads truer than "Not agreed" for someone who agreed and then withdrew.
-- Agreeing again clears it. The guard trigger covers it like the other two.

alter table public.instructors
  add column if not exists partner_sharing_stopped_at timestamptz;

comment on column public.instructors.partner_sharing_stopped_at is
  'When this instructor last stopped sharing with partners. NULL while they are sharing or have never agreed. Written only by stop_partner_sharing() / agree_partner_sharing(); history is in audit_events.';
comment on column public.instructors.partner_sharing_agreed_at is
  'When this instructor agreed the provider may share their name, contact info, screening status/date/expiry/company and training/acknowledgment dates with partner organizations where they teach (never the report). NULL = not agreed, or stopped (see partner_sharing_stopped_at). Written only by agree_partner_sharing() / stop_partner_sharing().';
comment on column public.instructors.partner_sharing_version is
  'Which wording they agreed to (PARTNER_SHARING_VERSION in src/lib/partnerSharing.js). NULL whenever partner_sharing_agreed_at is NULL. Written only by agree_partner_sharing() / stop_partner_sharing().';

create or replace function private.guard_instructor_partner_sharing()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.partner_sharing_agreed_at is not null
       or new.partner_sharing_version is not null
       or new.partner_sharing_stopped_at is not null then
      raise exception 'Only the instructor can agree to partner sharing'
        using errcode = 'PS001';
    end if;
  elsif new.partner_sharing_agreed_at is distinct from old.partner_sharing_agreed_at
     or new.partner_sharing_version is distinct from old.partner_sharing_version
     or new.partner_sharing_stopped_at is distinct from old.partner_sharing_stopped_at then
    raise exception 'Only the instructor can agree to partner sharing'
      using errcode = 'PS001';
  end if;
  return new;
end;
$$;

-- Same contract as 20261019a: true when the signed-in user's active instructor
-- row in that org now carries an agreement, false when there is none. Agreeing
-- twice keeps the FIRST timestamp and writes no second audit row.
create or replace function public.agree_partner_sharing(p_organization_id uuid, p_version text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return false;
  end if;
  if p_version is distinct from 'v2' then
    raise exception 'Unknown partner sharing wording version'
      using errcode = 'PS002';
  end if;

  -- One statement for every matching row: nothing makes (auth_user_id,
  -- organization_id) unique, and UPDATE ... RETURNING INTO errors on two rows.
  with agreed as (
    update public.instructors
       set partner_sharing_agreed_at = now(),
           partner_sharing_version = p_version,
           partner_sharing_stopped_at = null
     where auth_user_id = auth.uid()
       and organization_id = p_organization_id
       and is_active
       and partner_sharing_agreed_at is null
    returning id
  )
  insert into public.audit_events (organization_id, actor_user_id, actor_role, action, subject_type, subject_id, after)
  select p_organization_id, auth.uid(), 'instructor', 'partner_sharing_agreed', 'instructor', a.id,
         jsonb_build_object('version', p_version)
    from agreed a;

  return exists (
    select 1 from public.instructors
     where auth_user_id = auth.uid()
       and organization_id = p_organization_id
       and is_active
       and partner_sharing_agreed_at is not null
  );
end;
$$;

-- True when sharing is now off for the signed-in user's instructor row in that
-- org (including when it already was), false when they have no row there.
-- Not limited to active rows: someone who has left can still withdraw.
create or replace function public.stop_partner_sharing(p_organization_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return false;
  end if;

  -- The CTE reads each row's agreement BEFORE the update clears it (the old
  -- values are what the audit row must keep), and covers every matching row.
  with mine as (
    select i.id, i.partner_sharing_agreed_at as agreed_at, i.partner_sharing_version as version
      from public.instructors i
     where i.auth_user_id = auth.uid()
       and i.organization_id = p_organization_id
       and i.partner_sharing_agreed_at is not null
       for update
  ), stopped as (
    update public.instructors i
       set partner_sharing_agreed_at = null,
           partner_sharing_version = null,
           partner_sharing_stopped_at = now()
      from mine m
     where i.id = m.id
    returning m.id, m.agreed_at, m.version
  )
  insert into public.audit_events (organization_id, actor_user_id, actor_role, action, subject_type, subject_id, before)
  select p_organization_id, auth.uid(), 'instructor', 'partner_sharing_stopped', 'instructor', s.id,
         jsonb_build_object('agreed_at', s.agreed_at, 'version', s.version)
    from stopped s;

  return exists (
    select 1 from public.instructors
     where auth_user_id = auth.uid()
       and organization_id = p_organization_id
  );
end;
$$;

revoke all on function public.agree_partner_sharing(uuid, text) from public;
revoke all on function public.agree_partner_sharing(uuid, text) from anon;
grant execute on function public.agree_partner_sharing(uuid, text) to authenticated;
revoke all on function public.stop_partner_sharing(uuid) from public;
revoke all on function public.stop_partner_sharing(uuid) from anon;
grant execute on function public.stop_partner_sharing(uuid) to authenticated;
revoke all on function private.guard_instructor_partner_sharing() from public;
