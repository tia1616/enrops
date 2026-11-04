-- Seed requirement profiles (spec v3 Nov 6 check 12: "Seed profiles are loaded
-- for host-zero partners"; H2 section 6 "Against your requirements: one line per
-- rule"). Each required item on a partner's list can now say WHAT the partner
-- requires, in the partner's own words, and WHERE that is written, e.g.
-- Vancouver insurance: "General liability $1M per occurrence / $2M aggregate..."
-- from "2026 Recreation Services Agreement, page 6".
--
-- Shown as text to the partner and the provider. There is no automatic
-- Met/Gap: that needs the limits off each certificate, which are not typed in
-- (Jessica 2026-10-26, confirmed 2026-11-04 "profiles with limits shown").
--
-- Its own table: partner_requirements rows record only what someone ticked
-- (20261026a), so text must not create a tick. partner_requirements_for()
-- returns the text with each item; set_partner_requirement_detail() writes it
-- (owner/admin, audited). Empty text removes the row. A text change is
-- audited as partner_requirement_detail_set and does NOT move the requirements
-- version, which counts only what is required (20261102b).
--
-- Grants explicit (Supabase 2026-10-30 change).

create table if not exists public.partner_requirement_details (
  partner_id       uuid not null references public.partners(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  requirement_key  text not null,
  detail           text not null,
  source           text,
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  primary key (partner_id, requirement_key),
  constraint partner_requirement_details_key_check check (requirement_key in (
    'insurance', 'partner_agreement', 'business_license',
    'background_check', 'training', 'code_of_conduct', 'mandatory_reporter', 'contractor_agreement'
  )),
  constraint partner_requirement_details_detail_check check (char_length(btrim(detail)) between 1 and 600),
  constraint partner_requirement_details_source_check check (source is null or char_length(source) <= 200)
);

alter table public.partner_requirement_details enable row level security;
revoke all on public.partner_requirement_details from public, anon, authenticated;
grant all on public.partner_requirement_details to service_role;

comment on table public.partner_requirement_details is
  'What a partner requires for each item, in its own words, and where that is written. Read through partner_requirements_for(), written through set_partner_requirement_detail().';

-- Same access and defaults as before; now with each item's detail and source.
drop function if exists public.partner_requirements_for(uuid);
create function public.partner_requirements_for(p_partner_id uuid)
returns table (requirement_key text, required boolean, detail text, source text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select p.organization_id into v_org from public.partners p where p.id = p_partner_id;
  if v_org is null then
    return;
  end if;
  if not (
    public.is_org_member(v_org)
    or exists (select 1 from private.current_partner_access() a where a.partner_id = p_partner_id)
  ) then
    return;
  end if;

  return query
  with defaults(requirement_key, required, sort) as (
    values
      ('insurance', true, 1),
      ('partner_agreement', true, 2),
      ('business_license', false, 3),
      ('background_check', true, 4),
      ('training', true, 5),
      ('code_of_conduct', true, 6),
      ('mandatory_reporter', true, 7),
      ('contractor_agreement', true, 8)
  )
  select d.requirement_key, coalesce(r.required, d.required), x.detail, x.source
  from defaults d
  left join public.partner_requirements r
    on r.partner_id = p_partner_id and r.requirement_key = d.requirement_key
  left join public.partner_requirement_details x
    on x.partner_id = p_partner_id and x.requirement_key = d.requirement_key
  order by d.sort;
end;
$$;
revoke all on function public.partner_requirements_for(uuid) from public, anon;
grant execute on function public.partner_requirements_for(uuid) to authenticated, service_role;

create or replace function public.set_partner_requirement_detail(
  p_partner_id uuid,
  p_requirement_key text,
  p_detail text,
  p_source text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_detail text := nullif(btrim(coalesce(p_detail, '')), '');
  v_source text := nullif(btrim(coalesce(p_source, '')), '');
  v_before jsonb;
begin
  select p.organization_id into v_org from public.partners p where p.id = p_partner_id;
  if v_org is null or not public.can_admin_org(v_org) then
    return false;
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
  values (v_org, p_partner_id, auth.uid(), 'provider_admin', 'partner_requirement_detail_set', 'partner_requirement',
          jsonb_build_object('key', p_requirement_key) || coalesce(v_before, '{}'::jsonb),
          jsonb_build_object('key', p_requirement_key, 'detail', v_detail, 'source', v_source));
  return true;
end;
$$;
revoke all on function public.set_partner_requirement_detail(uuid, text, text, text) from public, anon;
grant execute on function public.set_partner_requirement_detail(uuid, text, text, text) to authenticated, service_role;
