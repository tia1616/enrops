-- Class photos: an instructor photographs a class, the photo is watermarked and
-- filed against that class and day, and every enrolled family sees it in the
-- parent portal.
--
-- SHAPE, AND WHY IT COPIES attendance_records. A photo belongs to a class on a
-- day, exactly like an attendance row, so it reuses that table's authority
-- rather than inventing a second one: private.instructor_attendance_access()
-- already answers "may THIS instructor act on THIS class on THIS date" and it
-- already covers the regular instructor and a confirmed substitute. A photo
-- policy that re-derived that would be a second spelling of one rule.
--
-- CLASSES ONLY (programs), NOT legacy camp_sessions. Camps are programs with
-- class_days since 2026-09-25. Legacy camp_sessions rows are old J2S summer
-- camps; a parent has no read path to camp_sessions that was verified, and the
-- season is over, so v1 does not reach them. A camp-as-program works.
--
-- DEFAULT OFF. organizations.class_photos_enabled is false for every tenant.
-- Turning on a new family-facing surface for providers who did not ask for it
-- is the mistake the mandatory photo-release gate made twice. J2S is switched
-- on by hand per environment in the same pass; this file stays tenant-neutral.
--
-- CONSENT. Only a recorded YES (registrations.photo_release_consent = true) is
-- permission. There is no per-child tagging, so the portal warns the instructor
-- about every child in the class WITHOUT a yes before they shoot, and any family
-- can flag a photo, which hides it from every family at once until an admin
-- restores or deletes it (flag_class_photo below).
--
-- PRIVATE BUCKET, NO PUBLIC URLS. Files are read through short-lived signed
-- URLs, and the storage SELECT policy is "a class_photos row exists for this
-- path that the caller can read" - the subquery runs under the caller's own
-- RLS, so the table policy is the single decision and storage cannot drift
-- from it. There is deliberately NO storage INSERT policy: the only writer is
-- the upload-class-photo edge function (it stamps the watermark first, so an
-- unmarked original can never be stored by a client).
--
-- Applied to staging and prod in the same pass. Additive and inert until a
-- provider switches the flag on.

begin;

-- 1. The per-provider switch. Plain boolean; an owner/admin can write it through
--    the existing organizations RLS (it is not a money column and is not in the
--    guard_organizations_locked_columns trigger).
alter table public.organizations
  add column if not exists class_photos_enabled boolean not null default false;

-- 2. The photo rows.
create table if not exists public.class_photos (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  program_id               uuid not null references public.programs(id) on delete cascade,
  session_date             date not null,
  storage_path             text not null unique,
  uploaded_by_instructor_id uuid references public.instructors(id) on delete set null,
  created_at               timestamptz not null default now(),
  -- A family reported this photo. Non-null hides it from every family.
  flagged_at               timestamptz,
  flagged_by_parent_id     uuid references public.parents(id) on delete set null,
  -- A row may only point at an object inside ITS OWN class's folder. Without
  -- this an instructor could POST a row straight to the table carrying another
  -- class's (or another provider's) object path: RLS on the row would pass, and
  -- because the storage policies key on "a row exists for this path" they would
  -- then sign, and delete, a photo that is not theirs. The unique constraint
  -- stops a second row on a path that already has one; this stops the first.
  constraint class_photos_path_in_own_class check (
    storage_path like organization_id::text || '/' || program_id::text || '/' || session_date::text || '/%.jpg'
  )
);

create index if not exists class_photos_program_date_idx
  on public.class_photos (program_id, session_date);
create index if not exists class_photos_org_flagged_idx
  on public.class_photos (organization_id) where flagged_at is not null;

alter table public.class_photos enable row level security;

-- 3. organization_id is authoritative from the class, never from the writer, and
--    a photo cannot be filed against a day that has not happened in the
--    provider's own timezone (an instructor in a later zone cannot pre-date).
create or replace function public.set_class_photos_org_and_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_org uuid;
  v_tz  text;
begin
  select pr.organization_id into v_org from public.programs pr where pr.id = new.program_id;
  if v_org is null then
    raise exception 'class_photos: program not found' using errcode = '23503';
  end if;
  new.organization_id := v_org;

  select o.timezone into v_tz from public.organizations o where o.id = v_org;
  if new.session_date > (now() at time zone coalesce(v_tz, 'America/Los_Angeles'))::date then
    raise exception 'class_photos: that class day has not happened yet' using errcode = '22007';
  end if;
  return new;
end;
$function$;

-- A trigger function needs no caller EXECUTE; the default grant would hand anon
-- one anyway (proacl read back on staging showed it).
revoke all on function public.set_class_photos_org_and_guard() from public, anon, authenticated;

drop trigger if exists class_photos_org_and_guard on public.class_photos;
create trigger class_photos_org_and_guard
  before insert on public.class_photos
  for each row execute function public.set_class_photos_org_and_guard();

-- 4. "Is the calling parent enrolled in this class". The enrolled predicate is
--    the one program_message_recipients and isOnRoster already use (paid or
--    confirmed, and not cancelled or waitlisted): a refunded family must not
--    keep seeing new photos. SECURITY DEFINER so the RLS check does not depend
--    on the parent's own read access to registrations.
create or replace function private.parent_enrolled_in_program(p_program_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public','pg_temp'
as $function$
  select exists (
    select 1
    from public.registrations r
    where r.parent_id = public.current_parent_id()
      and r.program_id = p_program_id
      and r.cancelled_at is null
      and r.status <> 'cancelled'
      and r.status <> 'waitlist'
      and (r.payment_status = 'paid' or r.status = 'confirmed')
  );
$function$;

revoke all on function private.parent_enrolled_in_program(uuid) from public, anon;
grant execute on function private.parent_enrolled_in_program(uuid) to authenticated;

-- 5. Table policies.
-- Instructors (regular or confirmed sub for that day) read the class's photos.
--
-- ACTIVE instructors only. private.current_instructor_id() does not look at
-- instructors.is_active, and instructor_attendance_access only needs a
-- 'confirmed' assignment row, so a deactivated instructor kept reading (and, by
-- direct API, writing) children's photos for as long as that row stayed. The
-- edge function already refuses them through resolveInstructor; these policies
-- say the same thing so the database does not depend on the function being the
-- only door.
create or replace function private.current_active_instructor_id()
returns uuid
language sql
stable
security definer
set search_path to 'public','pg_temp'
as $function$
  select i.id from public.instructors i
  where i.auth_user_id = auth.uid() and i.is_active
  limit 1;
$function$;

revoke all on function private.current_active_instructor_id() from public, anon;
grant execute on function private.current_active_instructor_id() to authenticated;

drop policy if exists class_photos_instructor_select on public.class_photos;
create policy class_photos_instructor_select on public.class_photos
  for select to authenticated
  using (
    private.current_active_instructor_id() is not null
    and private.instructor_attendance_access(program_id, null, session_date)
  );

-- Families read only photos nobody has flagged, for a class they are enrolled in.
drop policy if exists class_photos_parent_select on public.class_photos;
create policy class_photos_parent_select on public.class_photos
  for select to authenticated
  using (flagged_at is null and private.parent_enrolled_in_program(program_id));

-- The provider's own team reads everything, flagged included.
drop policy if exists class_photos_admin_select on public.class_photos;
create policy class_photos_admin_select on public.class_photos
  for select to authenticated
  using (public.is_org_member(organization_id) or public.is_platform_admin());

-- Is the provider's switch on for this class. A DEFINER helper, not an inline
-- subselect in the policy: an instructor has no read access to organizations, so
-- the inline form evaluated under their own RLS saw no row and refused EVERY
-- upload (caught by the rolled-back staging test, not by reading the policy).
create or replace function private.class_photos_enabled_for_program(p_program_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public','pg_temp'
as $function$
  select coalesce((
    select o.class_photos_enabled
    from public.programs pr
    join public.organizations o on o.id = pr.organization_id
    where pr.id = p_program_id
  ), false);
$function$;

revoke all on function private.class_photos_enabled_for_program(uuid) from public, anon;
grant execute on function private.class_photos_enabled_for_program(uuid) to authenticated;

-- An instructor files a photo only against a class they may act on, as
-- themselves, and only while the provider has the feature on. This INSERT is
-- the authorization decision for an upload: the edge function runs it under the
-- caller's JWT and lets this policy accept or refuse.
drop policy if exists class_photos_instructor_insert on public.class_photos;
create policy class_photos_instructor_insert on public.class_photos
  for insert to authenticated
  with check (
    uploaded_by_instructor_id = private.current_active_instructor_id()
    and private.instructor_attendance_access(program_id, null, session_date)
    and private.class_photos_enabled_for_program(program_id)
  );

-- Delete: the instructor who took it, or the provider's admins. The instructor
-- can NOT delete a photo a family has reported: that photo is evidence for the
-- admin who has to decide, and the person who took it should not be able to
-- make it disappear first.
drop policy if exists class_photos_delete on public.class_photos;
create policy class_photos_delete on public.class_photos
  for delete to authenticated
  using (
    (uploaded_by_instructor_id = private.current_active_instructor_id() and flagged_at is null)
    or public.can_edit_org(organization_id)
    or public.is_platform_admin()
  );

-- Update: only the provider's admins (restore a flagged photo). Families flag
-- through flag_class_photo(), never by writing the row.
drop policy if exists class_photos_admin_update on public.class_photos;
create policy class_photos_admin_update on public.class_photos
  for update to authenticated
  using (public.can_edit_org(organization_id) or public.is_platform_admin())
  with check (public.can_edit_org(organization_id) or public.is_platform_admin());

-- Table privileges: RLS decides rows, but the grants must exist or every
-- authenticated read is a 42501. No anon access of any kind.
revoke all on public.class_photos from public, anon, authenticated;
grant select, insert, update, delete on public.class_photos to authenticated;

-- 6. A family reports a photo. Hides it from every family immediately; the
--    provider's admins still see it and decide. Checks enrollment in the class
--    the photo belongs to, so a parent cannot hide another class's photos.
create or replace function public.flag_class_photo(p_photo_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_program uuid;
begin
  select cp.program_id into v_program from public.class_photos cp where cp.id = p_photo_id;
  if v_program is null then
    raise exception 'photo not found' using errcode = 'P0002';
  end if;
  if not private.parent_enrolled_in_program(v_program) then
    raise exception 'not enrolled in this class' using errcode = '42501';
  end if;
  update public.class_photos
     set flagged_at = coalesce(flagged_at, now()),
         flagged_by_parent_id = coalesce(flagged_by_parent_id, public.current_parent_id())
   where id = p_photo_id;
end;
$function$;

-- revoke from public does NOT remove anon's own EXECUTE grant (see the 20 Aug
-- parent-email leak); name anon explicitly, then read proacl back.
revoke all on function public.flag_class_photo(uuid) from public, anon;
grant execute on function public.flag_class_photo(uuid) to authenticated;

-- 7. The private bucket. 5 MB cap and JPEG only: the upload function always
--    writes a watermarked JPEG.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('class-photos', 'class-photos', false, 5242880, array['image/jpeg'])
on conflict (id) do nothing;

drop policy if exists class_photos_storage_select on storage.objects;
create policy class_photos_storage_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'class-photos'
    and exists (select 1 from public.class_photos cp where cp.storage_path = name)
  );

drop policy if exists class_photos_storage_delete on storage.objects;
create policy class_photos_storage_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'class-photos'
    and exists (
      select 1 from public.class_photos cp
      where cp.storage_path = name
        and (
          (cp.uploaded_by_instructor_id = private.current_active_instructor_id() and cp.flagged_at is null)
          or public.can_edit_org(cp.organization_id)
          or public.is_platform_admin()
        )
    )
  );

-- 8. Publish the switch to both portals. public_org_directory is the single
--    choke point both read; this appends ONE column and changes nothing else.
--    The select list is a verbatim copy of 20260914a, columns bare on purpose:
--    src/lib/instructorDocuments.test.mjs regex-matches the newest redefinition
--    of this view for the seven instructor-document keys, so do not alias
--    `organizations` here. reloptions is null on both databases (verified), so
--    CREATE OR REPLACE loses no security_invoker setting.
create or replace view public.public_org_directory as
  select
    id,
    slug,
    name,
    organizations.logo_url,
    logo_email_url,
    status,
    timezone,
    active_registration_term,
    jsonb_build_object(
      'enabled', coalesce((background_check_config ->> 'enabled')::boolean, true),
      'provider_name', background_check_config ->> 'provider_name',
      'provider_url', background_check_config ->> 'provider_url',
      'instructions', background_check_config ->> 'instructions'
    ) as background_check_public,
    coalesce((training_config ->> 'enabled')::boolean, false) as training_enabled,
    instructor_pay_model,
    coalesce(stripe_charges_enabled, false) as stripe_charges_enabled,
    jsonb_build_object(
      'contractor_status', coalesce((instructor_document_config -> 'contractor_status') <> 'false'::jsonb, true),
      'contractor_agreement', true,
      'pay_schedule', coalesce((instructor_document_config -> 'pay_schedule') <> 'false'::jsonb, true),
      'attendance_policy', coalesce((instructor_document_config -> 'attendance_policy') <> 'false'::jsonb, true),
      'code_of_conduct', coalesce((instructor_document_config -> 'code_of_conduct') <> 'false'::jsonb, true),
      'mandatory_reporter_ack', coalesce((instructor_document_config -> 'mandatory_reporter_ack') <> 'false'::jsonb, true),
      'photo_video_release', coalesce((instructor_document_config -> 'photo_video_release') <> 'false'::jsonb, true),
      'vehicle_driving_ack', coalesce((instructor_document_config -> 'vehicle_driving_ack') <> 'false'::jsonb, true)
    ) as instructor_documents_public,
    coalesce(instructor_pay_enabled, false) as instructor_pay_enabled,
    coalesce(
      nullif(btrim(b.email_reply_to), ''),
      nullif(btrim(email), '')
    ) as support_email,
    -- NEW. Appended last so no existing column moves.
    coalesce(class_photos_enabled, false) as class_photos_enabled
  from public.organizations
  left join public.org_branding b on b.organization_id = organizations.id
  where status = 'active';

commit;
