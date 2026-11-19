-- A partner roster carries HOMEROOM only for a school's after-school class.
-- Jessica 2026-11-19: "why is homeroom on there? it doesn't apply to camps or
-- any of these partners." Homeroom is a student attribute (students.homeroom_teacher),
-- saved once and reused, so a child's school homeroom followed them onto a
-- parks-and-rec roster where it means nothing to the partner.
--
-- private.partner_is_school() is the ONE place that says which partner types
-- are schools (the types on the Add partner pickers: public_school,
-- private_school, charter_school, school_district). Anything else (parks_rec,
-- community_org, church, null) is not a school.
--
-- partner_portal_class_roster (20261119a) is restated whole below. The ONLY
-- change is the homeroom column: null unless the roster is a class (not a
-- camp) at a school partner. Every gate, the log and both branches are
-- unchanged. The UI shows the Homeroom column only when some child has one.

create or replace function private.partner_is_school(p_partner_type text)
returns boolean
language sql
immutable
set search_path to ''
as $$
  select coalesce(p_partner_type in ('public_school', 'private_school', 'charter_school', 'school_district'), false);
$$;
revoke all on function private.partner_is_school(text) from public, anon, authenticated;

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
  v_homeroom boolean;
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

  -- Homeroom only for a school's class (20261119c). A partner whose type was
  -- never set might be a school, so it keeps homeroom: showing it to a parks
  -- department costs a column; hiding it from a school costs the answers.
  select p_kind = 'class' and (p.partner_type is null or private.partner_is_school(p.partner_type)) into v_homeroom
  from public.partners p where p.id = p_partner_id;

  if not v_admin then
    insert into public.audit_events (organization_id, partner_id, actor_user_id, actor_role, action, subject_type, subject_id)
    values (v_org, p_partner_id, auth.uid(), 'partner', 'roster_opened',
            case when p_kind = 'class' then 'program' else 'camp_session' end, p_class_id);
  end if;

  -- Two plain branches so each uses its own index. The inner join to students
  -- is the count's `student_id is not null`: same rows both ways.
  if p_kind = 'class' then
    return query
    select r.id, r.registered_at, st.first_name, st.last_name, st.grade,
           case when v_homeroom then st.homeroom_teacher end,
           st.dismissal_method, st.aftercare_provider
    from public.registrations r
    join public.students st on st.id = r.student_id
    where r.program_id = p_class_id and private.registration_on_roster(r);
  else
    return query
    select r.id, r.registered_at, st.first_name, st.last_name, st.grade,
           null::text,
           st.dismissal_method, st.aftercare_provider
    from public.registrations r
    join public.students st on st.id = r.student_id
    where r.camp_session_id = p_class_id and private.registration_on_roster(r);
  end if;
end;
$$;
revoke all on function public.partner_portal_class_roster(uuid, text, uuid) from public, anon;
grant execute on function public.partner_portal_class_roster(uuid, text, uuid) to authenticated;
