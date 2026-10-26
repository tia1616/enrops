-- Instructor permission to share their record with partner organizations.
--
-- The partner portal (20261012b, 20261013a) shows a partner the provider's
-- instructors at that partner's sites: name, contact info, background check
-- status and date, training and acknowledgment dates. Never the report itself.
-- Each recipient of background check information needs its own permission, so
-- the instructor agrees to this once, per provider, in writing.
--
-- REQUIRED, NOT A YES/NO (Jessica 2026-10-19). Unlike photo_release_consent
-- there is no stored "declined": partners require a cleared check for everyone
-- at their sites, so an instructor who will not agree cannot teach there
-- anyway. NULL means "not agreed yet", and the partner portal says exactly that.
--
-- ONE WRITER. Only the instructor can agree, through
-- public.agree_partner_sharing(), which binds to auth.uid(). An org admin can
-- write every other column on instructors (org_admins_write_instructors), so a
-- guard trigger refuses any change to these two columns that does not come from
-- that function. Otherwise "the instructor agreed" could be typed in by staff.
--
-- THE GUARD KEYS ON current_user, NOT ON A SESSION SETTING. A first draft let
-- the function set a custom GUC and the trigger trust it; any client can call
-- set_config() itself, and a rolled-back test proved an admin could spoof it.
-- current_user cannot be spoofed: a browser request runs as authenticated (or
-- anon), while the SECURITY DEFINER function runs as its owner. So client roles
-- are refused and everything server-side (the function, service_role) passes.

alter table public.instructors
  add column if not exists partner_sharing_agreed_at timestamptz,
  add column if not exists partner_sharing_version text;

comment on column public.instructors.partner_sharing_agreed_at is
  'When this instructor agreed the provider may share their name, contact info, background check status/date and training/acknowledgment dates with partner organizations where they teach (never the report). NULL = not agreed yet. Written only by agree_partner_sharing().';
comment on column public.instructors.partner_sharing_version is
  'Which wording they agreed to (PARTNER_SHARING_VERSION in src/lib/partnerSharing.js). NULL whenever partner_sharing_agreed_at is NULL.';

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
    if new.partner_sharing_agreed_at is not null or new.partner_sharing_version is not null then
      raise exception 'Only the instructor can agree to partner sharing'
        using errcode = 'PS001';
    end if;
  elsif new.partner_sharing_agreed_at is distinct from old.partner_sharing_agreed_at
     or new.partner_sharing_version is distinct from old.partner_sharing_version then
    raise exception 'Only the instructor can agree to partner sharing'
      using errcode = 'PS001';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_instructor_partner_sharing on public.instructors;
create trigger guard_instructor_partner_sharing
  before insert or update on public.instructors
  for each row execute function private.guard_instructor_partner_sharing();

-- Returns true when the signed-in user's instructor row in that org now carries
-- an agreement, false when they have no active instructor row there (an admin
-- previewing the portal, or a deactivated instructor). A state, not an error.
-- Agreeing twice keeps the FIRST timestamp: the record is when they agreed.
create or replace function public.agree_partner_sharing(p_organization_id uuid, p_version text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_found boolean;
begin
  if auth.uid() is null then
    return false;
  end if;
  if p_version is distinct from 'v1' then
    raise exception 'Unknown partner sharing wording version'
      using errcode = 'PS002';
  end if;

  update public.instructors
     set partner_sharing_agreed_at = coalesce(partner_sharing_agreed_at, now()),
         partner_sharing_version = coalesce(partner_sharing_version, p_version)
   where auth_user_id = auth.uid()
     and organization_id = p_organization_id
     and is_active;
  v_found := found;
  return v_found;
end;
$$;

revoke all on function public.agree_partner_sharing(uuid, text) from public;
revoke all on function public.agree_partner_sharing(uuid, text) from anon;
grant execute on function public.agree_partner_sharing(uuid, text) to authenticated;
revoke all on function private.guard_instructor_partner_sharing() from public;
