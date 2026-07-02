-- Membership-friendly recurring class schedule.
-- Third scheduled-instance shape alongside programs (term/reg) and camp_sessions
-- (dated camps). Drives instructor scheduling + "what's happening" comms; it is
-- NOT a registration funnel (no term / price / checkout). Additive + empty:
-- zero impact on existing tenants.
--
-- Applied to staging + prod the same pass. RLS/grants mirror `programs`
-- (org-member read, org-editor write; no public policy -> org-internal).

create table if not exists public.class_schedule (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  title text not null,
  offering_id uuid references curricula(id) on delete set null,
  day_of_week text not null,
  start_time text,
  end_time text,
  location_text text,
  program_location_id uuid references program_locations(id) on delete set null,
  instructor_name text,
  instructor_email text,
  instructor_id uuid references instructors(id) on delete set null,  -- structured link to the roster
  age_min integer,
  age_max integer,
  age_format text check (age_format is null or age_format = any (array['grade','age'])),
  capacity integer,
  effective_start_date date,
  effective_end_date date,
  status text not null default 'active' check (status = any (array['active','inactive','archived'])),
  notes text,
  source text not null default 'manual' check (source = any (array['manual','upload_csv','upload_doc','wufoo'])),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists class_schedule_org_idx on public.class_schedule(organization_id);
create index if not exists class_schedule_org_day_idx on public.class_schedule(organization_id, day_of_week);
create index if not exists class_schedule_instructor_idx on public.class_schedule(instructor_id) where instructor_id is not null;

alter table public.class_schedule enable row level security;

drop policy if exists members_read_class_schedule on public.class_schedule;
create policy members_read_class_schedule on public.class_schedule
  for select using (is_org_member(organization_id) or is_platform_admin());

drop policy if exists members_write_class_schedule on public.class_schedule;
create policy members_write_class_schedule on public.class_schedule
  for all using (can_edit_org(organization_id) or is_platform_admin())
  with check (can_edit_org(organization_id) or is_platform_admin());

create or replace function public.set_class_schedule_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_class_schedule_updated_at on public.class_schedule;
create trigger trg_class_schedule_updated_at
  before update on public.class_schedule
  for each row execute function public.set_class_schedule_updated_at();

grant select, insert, update, delete, references, trigger, truncate on public.class_schedule to anon;
grant select, insert, update, delete, references, trigger, truncate on public.class_schedule to authenticated;
grant select, insert, update, delete, references, trigger, truncate on public.class_schedule to service_role;
