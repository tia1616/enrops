-- A provider can put a flyer or social graphic on a class BEFORE the partner
-- asks for one (Jessica 2026-11-24, "Yes, build that": J2S has Happy Valley
-- flyers ready, and waiting for each park to tick its Marketing ask first made
-- the park set up before getting anything).
--
-- set_class_media (20261123r) restated with one change: when the class's
-- partner has asked for this item, its file types still apply, exactly as
-- before; when it hasn't, any type the bucket takes (PDF, JPG, PNG) is fine.
-- The class must still be at a partner's site: a flyer is for a partner to
-- use, so a class at the provider's own venue is refused as before.
-- Who may write, the path check, the lock and the replace are unchanged.

begin;

create or replace function public.set_class_media(
  p_kind text, p_class_id uuid, p_item_key text, p_storage_path text, p_filename text)
returns text
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_place record;
  v_types text[];
  v_ext text;
  v_old text;
begin
  select * into v_place from private.class_place(p_kind, p_class_id);
  if v_place.organization_id is null or not public.can_admin_org(v_place.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_place.partner_id is null then
    raise exception 'this class is not at a partner''s site' using errcode = '22023';
  end if;
  if p_item_key is null or p_item_key not in ('flyer', 'social_graphic') then
    raise exception 'unknown item' using errcode = '22023';
  end if;
  -- The partner's ask sets the file types; no ask, any type the bucket takes.
  select a.file_types into v_types from public.partner_marketing_asks a
  where a.partner_id = v_place.partner_id and a.item_key = p_item_key and a.wanted;
  v_types := coalesce(v_types, array['pdf', 'jpg', 'png']);
  if p_storage_path is null or p_storage_path not like v_place.organization_id::text || '/%' then
    raise exception 'the file must be in this provider''s folder' using errcode = '22023';
  end if;
  v_ext := lower(substring(p_storage_path from '\.([A-Za-z0-9]+)$'));
  if v_ext is null or not (v_ext = any(v_types)) then
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

revoke all on function public.set_class_media(text, uuid, text, text, text) from public, anon;
grant execute on function public.set_class_media(text, uuid, text, text, text) to authenticated;

commit;
