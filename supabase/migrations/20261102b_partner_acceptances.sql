-- Acceptance: a partner's dated decision on a provider's record (spec v3 §3
-- "Acceptance", H2 section 7, Nov 6 checks 8 and 9).
--
-- WHAT. A host admin at a partner records one of: accepted, accepted alongside
-- our own form, not accepted (note required). Each decision is its own row and
-- is never edited or deleted; a new decision writes a new row and the latest
-- row is the current decision. The row carries the requirements version it was
-- decided against, who decided (name and title as they were that day), and a
-- snapshot of the record as the partner saw it.
--
-- WHO. Only a host_admin login of that partner records a decision; a
-- host_viewer sees the history. The provider (any member) sees its partners'
-- decisions about it. No other partner sees anything (spec v3 §1.5: "shown to
-- the deciding host and the provider").
--
-- REQUIREMENTS VERSION. Until hosts publish their own profiles (H3), a
-- partner's requirements are the list the provider set from its packet
-- (20261026a). Its version is 1 plus the number of times that list changed,
-- counted from audit_events, which only set_partner_requirement() writes and
-- no role can edit. So the number cannot be moved by hand, and a decision made
-- before a change stays tied to the earlier number.
--
-- SNAPSHOT. Built here from the same sources the page reads (the documents
-- this partner sees with their status, partner_portal_instructors(), and
-- partner_requirements_for()), never sent by the browser, so a decision row
-- cannot carry a record that did not exist.
--
-- NO DIRECT TABLE ACCESS: reads and writes go through the two SECURITY
-- DEFINER functions. Grants explicit (Supabase 2026-10-30 change).

create table if not exists public.partner_acceptances (
  id                    uuid primary key default gen_random_uuid(),
  -- No cascade and no set-null: either would change an append-only row.
  organization_id       uuid not null references public.organizations(id),
  partner_id            uuid not null references public.partners(id),
  requirements_version  integer not null,
  decision              text not null,
  -- clock_timestamp, not now(): two decisions in one transaction still order.
  decided_at            timestamptz not null default clock_timestamp(),
  decided_by_user_id    uuid not null,
  decided_by_name       text,
  decided_by_title      text not null,
  note                  text,
  status_snapshot       jsonb not null,
  constraint partner_acceptances_decision_check check (decision in (
    'accepted', 'accepted_alongside_own_form', 'not_accepted', 'withdrawn'
  )),
  constraint partner_acceptances_note_check check (
    note is null or char_length(note) <= 500
  ),
  constraint partner_acceptances_note_required check (
    decision <> 'not_accepted' or char_length(btrim(coalesce(note, ''))) > 0
  ),
  constraint partner_acceptances_title_check check (
    char_length(btrim(decided_by_title)) between 1 and 100
  )
);
create index if not exists partner_acceptances_partner_time
  on public.partner_acceptances (partner_id, decided_at desc);

alter table public.partner_acceptances enable row level security;
revoke all on public.partner_acceptances from public, anon, authenticated;
grant all on public.partner_acceptances to service_role;

comment on table public.partner_acceptances is
  'Append-only: a partner''s decisions on a provider''s record. Written by record_partner_decision(), read by partner_decisions().';

create or replace function private.refuse_acceptance_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'partner_acceptances is append-only' using errcode = 'AC001';
end;
$$;
revoke all on function private.refuse_acceptance_change() from public;

drop trigger if exists partner_acceptances_append_only on public.partner_acceptances;
create trigger partner_acceptances_append_only
  before update or delete on public.partner_acceptances
  for each row execute function private.refuse_acceptance_change();
drop trigger if exists partner_acceptances_no_truncate on public.partner_acceptances;
create trigger partner_acceptances_no_truncate
  before truncate on public.partner_acceptances
  for each statement execute function private.refuse_acceptance_change();

-- The partner's current requirements version (see the header).
create or replace function private.partner_requirements_version(p_partner_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select 1 + count(*)::integer
  from public.audit_events e
  where e.partner_id = p_partner_id
    and e.action = 'partner_requirement_changed';
$$;
revoke all on function private.partner_requirements_version(uuid) from public, anon;

-- Record one decision. Returns the new row's id. Refuses (raises) for anyone
-- who is not a host_admin login of this partner.
create or replace function public.record_partner_decision(
  p_partner_id uuid,
  p_decision text,
  p_note text,
  p_title text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_name text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_title text := btrim(coalesce(p_title, ''));
  v_version integer;
  v_snapshot jsonb;
  v_id uuid;
begin
  select a.organization_id, c.contact_name into v_org, v_name
  from public.partner_portal_access a
  join public.partners p on p.id = a.partner_id
  join public.partner_contacts c on c.id = a.contact_id
  where a.partner_id = p_partner_id
    and a.auth_user_id = v_uid
    and v_uid is not null
    and a.role = 'host_admin'
    and coalesce(p.inactive, false) = false
  limit 1;
  if v_org is null then
    raise exception 'Only a host admin can record a decision' using errcode = 'AC002';
  end if;
  if p_decision not in ('accepted', 'accepted_alongside_own_form', 'not_accepted') then
    raise exception 'Unknown decision' using errcode = 'AC003';
  end if;

  v_version := private.partner_requirements_version(p_partner_id);
  v_snapshot := jsonb_build_object(
    'requirements', (
      select coalesce(jsonb_agg(jsonb_build_object('key', r.requirement_key, 'required', r.required)), '[]'::jsonb)
      from public.partner_requirements_for(p_partner_id) r
    ),
    'documents', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'doc_type', d.doc_type, 'title', d.title, 'partner_id', d.partner_id,
        'expires_on', d.expires_on, 'expiry_status', d.expiry_status
      ) order by d.doc_type, d.title), '[]'::jsonb)
      from public.provider_documents_with_status d
      where d.organization_id = v_org
        and (d.partner_id is null or d.partner_id = p_partner_id)
    ),
    'instructors', (
      select coalesce(jsonb_agg(to_jsonb(i) - 'email' - 'phone'), '[]'::jsonb)
      from public.partner_portal_instructors(p_partner_id) i
    )
  );

  insert into public.partner_acceptances (
    organization_id, partner_id, requirements_version, decision,
    decided_by_user_id, decided_by_name, decided_by_title, note, status_snapshot
  ) values (
    v_org, p_partner_id, v_version, p_decision,
    v_uid, v_name, v_title, v_note, v_snapshot
  )
  returning id into v_id;

  insert into public.audit_events (organization_id, partner_id, actor_user_id, actor_role, action, subject_type, subject_id, after)
  values (v_org, p_partner_id, v_uid, 'host_admin', 'acceptance_recorded', 'partner_acceptance', v_id,
          jsonb_build_object('decision', p_decision, 'requirements_version', v_version));
  return v_id;
end;
$$;
revoke all on function public.record_partner_decision(uuid, text, text, text) from public, anon;
grant execute on function public.record_partner_decision(uuid, text, text, text) to authenticated, service_role;

-- What the decision panel needs: whether this login may decide, the current
-- requirements version, the title last used by this person, and every
-- decision for this partner, newest first. The partner's own logins and the
-- provider's members only; anyone else gets null.
create or replace function public.partner_decisions(p_partner_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_role text;
begin
  select p.organization_id into v_org from public.partners p where p.id = p_partner_id;
  if v_org is null or v_uid is null then
    return null;
  end if;
  select a.role into v_role
  from private.current_partner_access() c
  join public.partner_portal_access a on a.partner_id = c.partner_id and a.auth_user_id = v_uid
  where c.partner_id = p_partner_id
  order by (a.role = 'host_admin') desc
  limit 1;
  if v_role is null and not public.is_org_member(v_org) then
    return null;
  end if;

  return jsonb_build_object(
    'can_decide', coalesce(v_role = 'host_admin', false),
    'requirements_version', private.partner_requirements_version(p_partner_id),
    'last_title', (
      select x.decided_by_title from public.partner_acceptances x
      where x.partner_id = p_partner_id and x.decided_by_user_id = v_uid
      order by x.decided_at desc limit 1
    ),
    'decisions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', x.id, 'decision', x.decision, 'decided_at', x.decided_at,
        'decided_by_name', x.decided_by_name, 'decided_by_title', x.decided_by_title,
        'note', x.note, 'requirements_version', x.requirements_version
      ) order by x.decided_at desc), '[]'::jsonb)
      from public.partner_acceptances x
      where x.partner_id = p_partner_id
    )
  );
end;
$$;
revoke all on function public.partner_decisions(uuid) from public, anon;
grant execute on function public.partner_decisions(uuid) to authenticated, service_role;
