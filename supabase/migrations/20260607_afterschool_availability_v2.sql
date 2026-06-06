-- Afterschool availability v2 — align the schema with the real provider availability
-- survey (Spring/Summer Availability form). Replaces the v1 model
-- (single earliest/latest window + per-LOCATION preference jsonb + unavailable_dates)
-- with what the survey actually collects:
--   * per-weekday multi-select time buckets
--   * days/week as a min..max range
--   * location preference ranked by AREA, term-keyed
--
-- AREA is a clean per-location label (program_locations.area), defaulted from the
-- location's address city and editable by the provider. The legacy `district`
-- column is too inconsistent to use (mix of districts, cities, and school names).
-- Curriculum preference is intentionally NOT modeled here: programs.curriculum
-- holds full names, not a category, and there is no non-hardcoded category source
-- yet. Curriculum was the weakest signal anyway; revisit when curricula gain a
-- category/tag.
--
-- Nothing here is J2S-specific: areas come from each tenant's locations, time
-- buckets are platform constants. RLS + grants mirror instructor_term_availability.

-- ----------------------------------------------------------------------------
-- 1. program_locations.area  (the unit location preference is ranked by)
-- ----------------------------------------------------------------------------
alter table public.program_locations
  add column if not exists area text;

comment on column public.program_locations.area is
  'Area/region label this location belongs to, ranked in the afterschool availability '
  'survey. Defaulted from the address city, provider-editable. Distinct from the legacy '
  '`district` column (which is inconsistent and not used by matching).';

-- ----------------------------------------------------------------------------
-- 2. instructor_term_availability: restructure to v2
-- ----------------------------------------------------------------------------

-- Per-weekday availability window, e.g. { "mon": { "from": "13:00", "until": "17:00" }, "wed": { "from": "14:30" } }.
-- `from` = earliest the instructor can be present (24h HH:MM); `until` optional upper bound.
-- A weekday absent = not available that day.
alter table public.instructor_term_availability
  add column if not exists weekday_availability jsonb not null default '{}'::jsonb,
  add column if not exists min_days integer;

comment on column public.instructor_term_availability.weekday_availability is
  'Per-weekday availability window. Keys mon..fri; each value { from: "HH:MM", until?: "HH:MM" } (24h).';
comment on column public.instructor_term_availability.min_days is
  'Lower bound of the instructor''s desired days/week range; max_days is the upper bound (the matcher cap).';

-- days/week is a range (min..max). Replace the v1 single-value check.
alter table public.instructor_term_availability
  drop constraint if exists instructor_term_availability_max_days_check;
alter table public.instructor_term_availability
  add constraint instructor_term_availability_days_range_check
    check (
      (min_days is null or (min_days between 1 and 5)) and
      (max_days is null or (max_days between 1 and 5)) and
      (min_days is null or max_days is null or min_days <= max_days)
    );

-- Drop the v1 columns the new model replaces.
alter table public.instructor_term_availability
  drop column if exists available_days,
  drop column if exists earliest_start,
  drop column if exists latest_end,
  drop column if exists unavailable_dates,
  drop column if exists location_preferences;

-- ----------------------------------------------------------------------------
-- 3. instructor_term_area_preferences (ranked by area; 4 levels incl. unavailable)
-- ----------------------------------------------------------------------------
create table if not exists public.instructor_term_area_preferences (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  instructor_id   uuid not null references public.instructors(id)   on delete cascade,
  term            text not null,
  area            text not null,
  preference      text not null
    check (preference in ('highly_preferred','preferred','not_preferred','unavailable')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint instructor_term_area_pref_unique unique (organization_id, instructor_id, term, area)
);

alter table public.instructor_term_area_preferences enable row level security;

create policy instructor_term_area_pref_org_manage
  on public.instructor_term_area_preferences for all
  using (is_org_member(organization_id) or is_platform_admin())
  with check (is_org_member(organization_id) or is_platform_admin());

create policy instructor_term_area_pref_self
  on public.instructor_term_area_preferences for all
  using (instructor_id in (select id from public.instructors where auth_user_id = auth.uid()))
  with check (instructor_id in (select id from public.instructors where auth_user_id = auth.uid()));

-- RLS is the gate; do not leave the Supabase default anon grants in place.
revoke all on public.instructor_term_area_preferences from anon;
grant select, insert, update, delete on public.instructor_term_area_preferences to authenticated;

create index if not exists idx_instr_term_area_pref_org_term
  on public.instructor_term_area_preferences (organization_id, term);
