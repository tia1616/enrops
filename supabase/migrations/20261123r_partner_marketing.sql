-- Marketing on the partner portal (build list step 7; Happy Valley and
-- Vancouver both asked for flyers; Jessica 2026-11-23: "the partner could set
-- their own requirements here too, 'media requirements' like social graphic,
-- flyer file type ... also ADA compliant, have partner logo on flyer/social.
-- allow partner to upload logo so it's available to provider").
--
-- The pattern Peachjar (school districts) and event sponsor portals use: the
-- host publishes, once, what it wants and in what format; each provider
-- uploads against that list, per class.
--
--   partner_marketing_asks  what the partner wants: a flyer and/or a social
--                           graphic, the file types it takes, whether it must
--                           carry the partner's logo and be accessible (ADA),
--                           and a note in its own words. Set by the partner's
--                           every-site admin (the same rule as its
--                           requirements, private.requirements_editor).
--   partner_logos           the partner's logo, uploaded by that admin, for
--                           the provider to download and put on the flyer.
--   class_media             the provider's flyer / social graphic per class.
--
-- KEPT APART FROM COMPLIANCE on purpose: none of these touch
-- partner_requirements, its version, the Decision, provider_documents, the
-- expiry emails or the Monday summary. Marketing never counts toward "meets N
-- of N" and is never red. Its audit actions are new names, so they never make
-- the requirements list "set by the partner" (partner_owns_requirements reads
-- only partner_requirement_changed / partner_requirement_detail_set).

begin;

-- ---------------------------------------------------------------- the asks
create table public.partner_marketing_asks (
  partner_id uuid not null references public.partners(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  item_key text not null,
  wanted boolean not null default false,
  file_types text[] not null default array['pdf', 'jpg', 'png'],
  needs_logo boolean not null default false,
  needs_accessible boolean not null default false,
  note text,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (partner_id, item_key),
  constraint partner_marketing_asks_item_check check (item_key in ('flyer', 'social_graphic')),
  constraint partner_marketing_asks_types_check check (
    cardinality(file_types) >= 1 and file_types <@ array['pdf', 'jpg', 'png']),
  constraint partner_marketing_asks_note_check check (note is null or char_length(note) <= 300),
  -- Accessible (ADA) is asked of flyers only, never social graphics (Jessica 2026-11-23).
  constraint partner_marketing_asks_accessible_check check (item_key = 'flyer' or not needs_accessible)
);
alter table public.partner_marketing_asks enable row level security;

-- Read: the provider's members, or any login of that partner.
create policy partner_marketing_asks_select on public.partner_marketing_asks
  for select to authenticated using (
    public.is_org_member(organization_id)
    or exists (select 1 from private.current_partner_access() a
               where a.partner_id = partner_marketing_asks.partner_id
                 and a.organization_id = partner_marketing_asks.organization_id));
grant select on public.partner_marketing_asks to authenticated;
grant all on public.partner_marketing_asks to service_role;

create or replace function public.set_partner_marketing_ask(
  p_partner_id uuid, p_item_key text, p_wanted boolean, p_file_types text[],
  p_needs_logo boolean, p_needs_accessible boolean, p_note text)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_org uuid;
  v_role text;
  v_before jsonb;
  v_after jsonb;
  v_types text[];
begin
  select p.organization_id into v_org from public.partners p where p.id = p_partner_id;
  v_role := case when v_org is null then null else private.requirements_editor(p_partner_id, v_org) end;
  if v_role is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_item_key is null or p_item_key not in ('flyer', 'social_graphic') then
    raise exception 'unknown item' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct t order by t), '{}') into v_types
  from unnest(coalesce(p_file_types, '{}')) t;
  if cardinality(v_types) = 0 or not (v_types <@ array['pdf', 'jpg', 'png']) then
    raise exception 'pick at least one file type: PDF, JPG or PNG' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('partner_marketing:' || p_partner_id::text || ':' || p_item_key));
  select to_jsonb(m) - 'updated_at' - 'updated_by' into v_before
  from public.partner_marketing_asks m where m.partner_id = p_partner_id and m.item_key = p_item_key;

  insert into public.partner_marketing_asks
    (partner_id, organization_id, item_key, wanted, file_types, needs_logo, needs_accessible, note, updated_by, updated_at)
  values
    (p_partner_id, v_org, p_item_key, coalesce(p_wanted, false), v_types,
     coalesce(p_needs_logo, false), p_item_key = 'flyer' and coalesce(p_needs_accessible, false),
     nullif(btrim(coalesce(p_note, '')), ''), auth.uid(), now())
  on conflict (partner_id, item_key) do update set
    wanted = excluded.wanted, file_types = excluded.file_types, needs_logo = excluded.needs_logo,
    needs_accessible = excluded.needs_accessible, note = excluded.note,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at
  returning to_jsonb(partner_marketing_asks) - 'updated_at' - 'updated_by' into v_after;

  if v_before is distinct from v_after then
    insert into public.audit_events (organization_id, partner_id, actor_user_id, actor_role, action, subject_type, before, after)
    values (v_org, p_partner_id, auth.uid(), v_role, 'partner_marketing_ask_set', 'partner_marketing_ask', v_before, v_after);
  end if;
end;
$$;
revoke all on function public.set_partner_marketing_ask(uuid, text, boolean, text[], boolean, boolean, text) from public, anon;
grant execute on function public.set_partner_marketing_ask(uuid, text, boolean, text[], boolean, boolean, text) to authenticated;

-- ---------------------------------------------------------------- the logo
create table public.partner_logos (
  partner_id uuid primary key references public.partners(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  storage_path text not null unique,
  original_filename text,
  uploaded_by uuid,
  uploaded_at timestamptz not null default now(),
  constraint partner_logos_path_in_partner_folder check (storage_path like partner_id::text || '/%')
);
alter table public.partner_logos enable row level security;
create policy partner_logos_select on public.partner_logos
  for select to authenticated using (
    public.is_org_member(organization_id)
    or exists (select 1 from private.current_partner_access() a
               where a.partner_id = partner_logos.partner_id
                 and a.organization_id = partner_logos.organization_id));
grant select on public.partner_logos to authenticated;
grant all on public.partner_logos to service_role;

-- Can the caller upload this partner's logo? Its every-site admin.
create or replace function private.can_edit_partner_logo(p_partner_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce((
    select private.requirements_editor(p.id, p.organization_id) is not null
    from public.partners p where p.id = p_partner_id), false);
$$;
revoke all on function private.can_edit_partner_logo(uuid) from public, anon;
grant execute on function private.can_edit_partner_logo(uuid) to authenticated;

-- Point the partner's logo at an uploaded file (replacing any). Returns the
-- replaced file's path for the caller to remove, or null.
create or replace function public.set_partner_logo(p_partner_id uuid, p_storage_path text, p_filename text)
returns text
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_org uuid;
  v_role text;
  v_old text;
begin
  select p.organization_id into v_org from public.partners p where p.id = p_partner_id;
  v_role := case when v_org is null then null else private.requirements_editor(p_partner_id, v_org) end;
  if v_role is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_storage_path is null or p_storage_path not like p_partner_id::text || '/%' then
    raise exception 'the file must be in this partner''s folder' using errcode = '22023';
  end if;
  select l.storage_path into v_old from public.partner_logos l where l.partner_id = p_partner_id;
  insert into public.partner_logos (partner_id, organization_id, storage_path, original_filename, uploaded_by, uploaded_at)
  values (p_partner_id, v_org, p_storage_path, nullif(btrim(coalesce(p_filename, '')), ''), auth.uid(), now())
  on conflict (partner_id) do update set storage_path = excluded.storage_path,
    original_filename = excluded.original_filename, uploaded_by = excluded.uploaded_by, uploaded_at = excluded.uploaded_at;
  insert into public.audit_events (organization_id, partner_id, actor_user_id, actor_role, action, subject_type, before, after)
  values (v_org, p_partner_id, auth.uid(), v_role, 'partner_logo_set', 'partner_logo',
    case when v_old is null then null else jsonb_build_object('file', v_old) end,
    jsonb_build_object('file', p_storage_path));
  return v_old;
end;
$$;
revoke all on function public.set_partner_logo(uuid, text, text) from public, anon;
grant execute on function public.set_partner_logo(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------- per class
create table public.class_media (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  program_id uuid references public.programs(id) on delete cascade,
  camp_session_id uuid references public.camp_sessions(id) on delete cascade,
  item_key text not null,
  storage_path text not null unique,
  original_filename text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint class_media_one_class check ((program_id is null) <> (camp_session_id is null)),
  constraint class_media_item_check check (item_key in ('flyer', 'social_graphic')),
  constraint class_media_path_in_own_org check (storage_path like organization_id::text || '/%')
);
create unique index class_media_one_per_program on public.class_media (program_id, item_key) where program_id is not null;
create unique index class_media_one_per_camp on public.class_media (camp_session_id, item_key) where camp_session_id is not null;
alter table public.class_media enable row level security;

-- The class's organization and site, or nulls when it doesn't exist.
create or replace function private.class_place(p_kind text, p_class_id uuid)
returns table(organization_id uuid, location_id uuid, partner_id uuid)
language sql
stable
security definer
set search_path to ''
as $$
  select x.org, pl.id, pl.partner_id
  from (
    select pr.organization_id as org, pr.program_location_id as loc
      from public.programs pr where p_kind = 'class' and pr.id = p_class_id
    union all
    select cs.organization_id, cs.location_id
      from public.camp_sessions cs where p_kind = 'camp' and cs.id = p_class_id
  ) x
  left join public.program_locations pl on pl.id = x.loc;
$$;
revoke all on function private.class_place(text, uuid) from public, anon, authenticated;

-- Can the caller see this class's media? The provider's members; a partner
-- login whose access covers the class's site (the partner_portal_classes rule).
create or replace function private.can_read_class_media(p_media_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists (
    select 1
    from public.class_media m
    cross join lateral private.class_place(
      case when m.program_id is not null then 'class' else 'camp' end,
      coalesce(m.program_id, m.camp_session_id)) c
    where m.id = p_media_id
      and auth.uid() is not null
      and (
        public.is_org_member(m.organization_id)
        or (c.partner_id is not null and exists (
          select 1 from private.current_partner_access() a
          where a.partner_id = c.partner_id and a.organization_id = m.organization_id
            and (private.partner_access_sites(a.partner_id) is null
                 or c.location_id = any(private.partner_access_sites(a.partner_id)))))
      )
  );
$$;
revoke all on function private.can_read_class_media(uuid) from public, anon;
grant execute on function private.can_read_class_media(uuid) to authenticated;

create policy class_media_select on public.class_media
  for select to authenticated using (private.can_read_class_media(id));
grant select on public.class_media to authenticated;
grant all on public.class_media to service_role;

-- Put a flyer or social graphic on a class (replacing any). Only what the
-- class's partner asks for, in a file type it takes. Returns the replaced
-- file's path for the caller to remove, or null.
create or replace function public.set_class_media(
  p_kind text, p_class_id uuid, p_item_key text, p_storage_path text, p_filename text)
returns text
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_place record;
  v_ask public.partner_marketing_asks;
  v_ext text;
  v_old text;
begin
  select * into v_place from private.class_place(p_kind, p_class_id);
  if v_place.organization_id is null or not public.can_admin_org(v_place.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_ask from public.partner_marketing_asks a
  where a.partner_id = v_place.partner_id and a.item_key = p_item_key and a.wanted;
  if not found then
    raise exception 'this partner hasn''t asked for that' using errcode = '22023';
  end if;
  if p_storage_path is null or p_storage_path not like v_place.organization_id::text || '/%' then
    raise exception 'the file must be in this provider''s folder' using errcode = '22023';
  end if;
  v_ext := lower(substring(p_storage_path from '\.([A-Za-z0-9]+)$'));
  if v_ext is null or not (v_ext = any(v_ask.file_types)) then
    raise exception 'file type not accepted' using errcode = '22023';
  end if;

  -- Two uploads to one class at once queue here instead of colliding.
  perform pg_advisory_xact_lock(hashtext('class_media:' || p_kind || ':' || p_class_id::text || ':' || p_item_key));
  select m.storage_path into v_old from public.class_media m
  where m.item_key = p_item_key
    and ((p_kind = 'class' and m.program_id = p_class_id) or (p_kind = 'camp' and m.camp_session_id = p_class_id));
  delete from public.class_media m
  where m.item_key = p_item_key
    and ((p_kind = 'class' and m.program_id = p_class_id) or (p_kind = 'camp' and m.camp_session_id = p_class_id));
  insert into public.class_media (organization_id, program_id, camp_session_id, item_key, storage_path, original_filename)
  values (v_place.organization_id,
    case when p_kind = 'class' then p_class_id end,
    case when p_kind = 'camp' then p_class_id end,
    p_item_key, p_storage_path, nullif(btrim(coalesce(p_filename, '')), ''));
  return v_old;
end;
$$;

-- Take a flyer or social graphic off a class. Returns its path, for the
-- caller to remove.
create or replace function public.remove_class_media(p_kind text, p_class_id uuid, p_item_key text)
returns text
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_place record;
  v_old text;
begin
  select * into v_place from private.class_place(p_kind, p_class_id);
  if v_place.organization_id is null or not public.can_admin_org(v_place.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.class_media m
  where m.item_key = p_item_key
    and ((p_kind = 'class' and m.program_id = p_class_id) or (p_kind = 'camp' and m.camp_session_id = p_class_id))
  returning m.storage_path into v_old;
  return v_old;
end;
$$;

revoke all on function public.set_class_media(text, uuid, text, text, text) from public, anon;
grant execute on function public.set_class_media(text, uuid, text, text, text) to authenticated;
revoke all on function public.remove_class_media(text, uuid, text) from public, anon;
grant execute on function public.remove_class_media(text, uuid, text) to authenticated;

-- ---------------------------------------------------------------- storage
-- One private bucket. Class media under <provider org id>/, logos under
-- <partner id>/, so each folder's writer is checked by its own rule.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('partner-marketing', 'partner-marketing', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

create policy partner_marketing_storage_insert on storage.objects for insert to authenticated
  with check (
    case when bucket_id = 'partner-marketing'
           and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         then public.can_admin_org(((storage.foldername(name))[1])::uuid)
              or private.can_edit_partner_logo(((storage.foldername(name))[1])::uuid)
         else false end);
create policy partner_marketing_storage_delete on storage.objects for delete to authenticated
  using (
    case when bucket_id = 'partner-marketing'
           and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         then public.can_admin_org(((storage.foldername(name))[1])::uuid)
              or private.can_edit_partner_logo(((storage.foldername(name))[1])::uuid)
         else false end);
-- Read: whoever can see the row pointing at the file (each table's own rule),
-- or the folder's writer (a file just uploaded, before its row exists).
create policy partner_marketing_storage_select on storage.objects for select to authenticated
  using (
    case when bucket_id = 'partner-marketing' then
      exists (select 1 from public.class_media m where m.storage_path = objects.name)
      or exists (select 1 from public.partner_logos l where l.storage_path = objects.name)
      or case when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then public.can_admin_org(((storage.foldername(name))[1])::uuid)
                   or private.can_edit_partner_logo(((storage.foldername(name))[1])::uuid)
              else false end
    else false end);

-- Explicit table access, the same on both databases whatever their defaults
-- (staging still hands new tables to anon; prod since 10/30 hands out none).
revoke all on public.partner_marketing_asks, public.partner_logos, public.class_media from public, anon, authenticated;
grant select on public.partner_marketing_asks, public.partner_logos, public.class_media to authenticated;
grant all on public.partner_marketing_asks, public.partner_logos, public.class_media to service_role;

commit;
