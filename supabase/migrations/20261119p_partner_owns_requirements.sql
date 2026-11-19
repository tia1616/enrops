-- Partner portal step 4a: the partner sets its own requirements checklist.
-- Spec v3 H3 ("the host edits the same list itself"); Stacey Allington
-- (Vancouver, 2026-11-09): "a direct checklist controlled by partners".
-- Decided 2026-11-09: for the pilot the provider pre-ticks each partner's list;
-- the partner can then take it over.
--
-- ONE OWNER, NEVER TWO. A partner's host_admin login may change its list
-- (which items are required, and what it requires for each, in its own words).
-- The moment it has done so once, the list is the partner's: the provider's
-- page shows "Set by <partner>" and the provider can no longer overwrite it.
-- Until then the provider's owner/admin edits it as before. Who owns it is
-- DERIVED from the append-only audit log (a partner-made change exists), not
-- stored in a second place that could disagree with the log.
--
-- Host viewers read the list; only host_admin logins change it, the same line
-- record_partner_decision draws.
--
-- Unchanged on purpose: the defaults and the list itself
-- (private.partner_requirements_list / partner_requirements_for), every reader
-- of it (Monday summary, invites, decisions, the partner page), and the
-- requirements version, which already counts every partner_requirement_changed
-- row whoever made it.

-- ---------------------------------------------------------------------------
-- 1. Has this partner taken its list over? One place for the rule.
create or replace function private.partner_owns_requirements(p_partner_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists (
    select 1 from public.audit_events e
    where e.partner_id = p_partner_id
      and e.actor_role = 'host_admin'
      and e.action in ('partner_requirement_changed', 'partner_requirement_detail_set')
  );
$$;
revoke all on function private.partner_owns_requirements(uuid) from public, anon, authenticated;

-- 2. Who is calling, for these two writes: 'host_admin' (this partner's admin
-- login), 'provider_admin' (the provider's owner/admin, and the partner has not
-- taken the list over), or null (refused).
create or replace function private.requirements_editor(p_partner_id uuid, p_org uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  select case
    when auth.uid() is null then null
    when exists (
      select 1 from public.partner_portal_access a
      join public.partners p on p.id = a.partner_id
      where a.auth_user_id = auth.uid() and a.partner_id = p_partner_id
        and a.organization_id = p_org and a.role = 'host_admin'
        and coalesce(p.inactive, false) = false
    ) then 'host_admin'
    when public.can_admin_org(p_org) and not private.partner_owns_requirements(p_partner_id) then 'provider_admin'
    else null
  end;
$$;
revoke all on function private.requirements_editor(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. set_partner_requirement (20261026a), restated whole. Changes: who may
-- call (requirements_editor) and actor_role says who did it.
create or replace function public.set_partner_requirement(p_partner_id uuid, p_requirement_key text, p_required boolean)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_org uuid;
  v_before boolean;
  v_role text;
begin
  select p.organization_id into v_org from public.partners p where p.id = p_partner_id;
  if v_org is null then
    return false;
  end if;
  v_role := private.requirements_editor(p_partner_id, v_org);
  if v_role is null then
    return false;
  end if;
  if p_required is null then
    raise exception 'required must be true or false' using errcode = 'PR001';
  end if;

  -- Two people changing the same item at once queue here, so each audit row's
  -- "before" is the value the other one left (the repo's advisory-lock shape).
  perform pg_advisory_xact_lock(hashtext('partner_requirement:' || p_partner_id::text || ':' || coalesce(p_requirement_key, '')));

  select f.required into v_before
  from public.partner_requirements_for(p_partner_id) f
  where f.requirement_key = p_requirement_key;
  if not found then
    raise exception 'Unknown requirement' using errcode = 'PR002';
  end if;

  insert into public.partner_requirements (partner_id, organization_id, requirement_key, required, updated_at, updated_by)
  values (p_partner_id, v_org, p_requirement_key, p_required, now(), auth.uid())
  on conflict (partner_id, requirement_key)
  do update set required = excluded.required, updated_at = now(), updated_by = auth.uid();

  if v_before is distinct from p_required then
    insert into public.audit_events (organization_id, partner_id, actor_user_id, actor_role, action, subject_type, before, after)
    values (v_org, p_partner_id, auth.uid(), v_role, 'partner_requirement_changed', 'partner_requirement',
            jsonb_build_object('key', p_requirement_key, 'required', v_before),
            jsonb_build_object('key', p_requirement_key, 'required', p_required));
  end if;
  return true;
end;
$$;
revoke all on function public.set_partner_requirement(uuid, text, boolean) from public, anon;
grant execute on function public.set_partner_requirement(uuid, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. set_partner_requirement_detail (20261104b), restated whole. Same two
-- changes. A detail for an unknown item is refused (it was silently stored).
create or replace function public.set_partner_requirement_detail(p_partner_id uuid, p_requirement_key text, p_detail text, p_source text)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_org uuid;
  v_detail text := nullif(btrim(coalesce(p_detail, '')), '');
  v_source text := nullif(btrim(coalesce(p_source, '')), '');
  v_before jsonb;
  v_role text;
begin
  select p.organization_id into v_org from public.partners p where p.id = p_partner_id;
  if v_org is null then
    return false;
  end if;
  v_role := private.requirements_editor(p_partner_id, v_org);
  if v_role is null then
    return false;
  end if;
  if not exists (select 1 from private.partner_requirements_list(p_partner_id) l where l.requirement_key = p_requirement_key) then
    raise exception 'Unknown requirement' using errcode = 'PR002';
  end if;

  select jsonb_build_object('detail', x.detail, 'source', x.source) into v_before
  from public.partner_requirement_details x
  where x.partner_id = p_partner_id and x.requirement_key = p_requirement_key;

  if v_detail is null then
    delete from public.partner_requirement_details x
    where x.partner_id = p_partner_id and x.requirement_key = p_requirement_key;
  else
    insert into public.partner_requirement_details (partner_id, organization_id, requirement_key, detail, source, updated_at, updated_by)
    values (p_partner_id, v_org, p_requirement_key, v_detail, v_source, now(), auth.uid())
    on conflict (partner_id, requirement_key) do update
      set detail = excluded.detail, source = excluded.source, updated_at = now(), updated_by = auth.uid();
  end if;

  insert into public.audit_events (organization_id, partner_id, actor_user_id, actor_role, action, subject_type, before, after)
  values (v_org, p_partner_id, auth.uid(), v_role, 'partner_requirement_detail_set', 'partner_requirement',
          jsonb_build_object('key', p_requirement_key) || coalesce(v_before, '{}'::jsonb),
          jsonb_build_object('key', p_requirement_key, 'detail', v_detail, 'source', v_source));
  return true;
end;
$$;
revoke all on function public.set_partner_requirement_detail(uuid, text, text, text) from public, anon;
grant execute on function public.set_partner_requirement_detail(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. What the page needs to draw the list: may THIS caller edit it, and has
-- the partner taken it over (and when). Readable by the partner's logins and
-- the provider's owner/admin; nothing for anyone else.
create or replace function public.partner_requirements_control(p_partner_id uuid)
returns table(can_edit boolean, set_by_partner boolean, set_by_partner_on date)
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_org uuid;
  v_ok boolean;
  v_tz text;
begin
  select s.organization_id, s.allowed into v_org, v_ok
  from private.partner_portal_scope(p_partner_id) s;
  if not coalesce(v_ok, false) then
    return;
  end if;
  select coalesce(o.timezone, 'America/Los_Angeles') into v_tz from public.organizations o where o.id = v_org;
  return query
  select private.requirements_editor(p_partner_id, v_org) is not null,
         private.partner_owns_requirements(p_partner_id),
         (select (min(e.occurred_at) at time zone v_tz)::date
            from public.audit_events e
           where e.partner_id = p_partner_id and e.actor_role = 'host_admin'
             and e.action in ('partner_requirement_changed', 'partner_requirement_detail_set'));
end;
$$;
revoke all on function public.partner_requirements_control(uuid) from public, anon;
grant execute on function public.partner_requirements_control(uuid) to authenticated;
