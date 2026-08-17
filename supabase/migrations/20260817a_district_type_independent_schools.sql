-- Private / charter / independent schools stop being fake one-school districts.
--
-- WHAT THIS TABLE ACTUALLY IS. `districts` already carries calendar_key,
-- flyer_distribution and flyer_notes, and CalendarsList enumerates its rows as the
-- calendar-upload targets. So it is really "a thing that owns a school calendar and
-- groups schools under it". For a public district, that thing IS a district.
--
-- THE PROBLEM. A private/charter school owns its own calendar and belongs to no
-- district, but the only way to give one a calendar today is to invent a
-- one-school district row for it -- CalendarsList's empty state literally
-- instructs the operator to do that ("Give a school a District ... then come back
-- here"). The cost lands on the public registration picker, which groups by
-- district, so a parent sees a district heading called "Catlin Gabel School"
-- containing exactly one school called Catlin Gabel School.
--
-- On PROD j2s today that is four rows, each with exactly one linked site:
--   Catlin Gabel School, Oregon Episcopal School, Portland Christian Schools,
--   North Clackamas Christian School.
-- Jessica, 2026-08-17: "on j2s - i've always not liked this."
--
-- WHY TYPE THE ROW RATHER THAN REMOVE IT. Clearing a private school's district_id
-- would fix the picker and take its calendar away, because calendars attach to
-- districts. Those two requirements are the two ends of one trade. Typing the row
-- breaks the coupling instead: the row stays, so the entire calendar pipeline
-- (upload, parse, early release, derive_program_session_dates) is untouched and
-- keeps working exactly as it does, while the picker reads the type and routes
-- every independent school into the single "Other schools & sites" bucket it
-- already has (see lib/regCatalogPicker.js, OTHER_DISTRICT).
--
-- ADDITIVE AND INERT. The default keeps every existing row on today's behaviour.
-- Nothing changes anywhere until a row is deliberately retyped, which is a
-- separate, per-tenant data decision.
alter table districts
  add column if not exists district_type text not null default 'district';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'districts_district_type_check'
  ) then
    alter table districts
      add constraint districts_district_type_check
      check (district_type in ('district', 'independent_school'));
  end if;
end $$;

comment on column districts.district_type is
  'district = a real school district that groups schools under its name. independent_school = a private/charter/independent school that owns its own calendar and must NOT render as its own heading in the public registration picker; it falls into the shared "Other schools & sites" bucket instead. Both types are calendar-upload targets on the Calendars page.';

-- The view parents read. districts.public_read_districts is TO anon ONLY, so a
-- signed-in family reads districts through this view or not at all -- that was the
-- 14 Aug prod incident (19 districts signed out, 0 signed in).
--
-- security_invoker = false is CARRIED EXPLICITLY, not omitted. It is set on the
-- live view on both environments, and it is the whole reason an authenticated
-- parent can read this at all. CREATE OR REPLACE resets reloptions to what is
-- stated here, so leaving it out is how Jeff's registration page breaks a second
-- time.
--
-- The new column is APPENDED, which is what makes CREATE OR REPLACE legal here and
-- preserves the existing anon + authenticated grants. A DROP + CREATE would reset
-- them -- the 20260814f lesson, where dropping an object to change its shape
-- silently restored a PUBLIC default.
create or replace view districts_public
  with (security_invoker = false) as
  select id, organization_id, name, district_type
  from districts
  where organization_id in (select public_org_directory.id from public_org_directory);

-- RESTATED, because CREATE OR REPLACE VIEW keeps the OLD comment. The previous one
-- said "Only (id, organization_id, name)" and listed the operator-only columns it
-- excluded -- so after the statement above it told anyone auditing what anon can read
-- that this view carries THREE columns when it now carries four. That audit is
-- exactly the one that followed the 13/14 Aug district-read incidents, and a stale
-- comment is the worst possible thing for it to find (/code-review, 2026-08-17).
-- Same class as the reloptions note above: CREATE OR REPLACE preserves more than
-- people expect, so anything it preserves has to be restated deliberately.
comment on view districts_public is
  'Anon-safe district rows for the public registration catalog. Readable by anon AND authenticated, because parents are not org_members and a signed-in family must see the same grouping a signed-out one does. Exposes exactly (id, organization_id, name, district_type) -- district_type was appended by 20260817a so the picker can keep an independent_school out of its own heading. Operator-only columns (calendar_key, flyer_distribution, flyer_notes) stay behind org_access_districts on the base table.';
