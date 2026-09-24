-- Camps get the fields after-school programs already have.
--
-- The camp builder was written from the camp_sessions schema instead of from the
-- program wizard, so it inherited that table's gaps. Comparing the two forms
-- field by field, camps could not express things the product already supports
-- for after-school:
--
--   grades  - the 2026-27 pricing sheet sells "App Builders Camp, Grades 4 to 6",
--             and camp_sessions had ages only. A grade-based camp was simply not
--             expressible. programs carries age_format + grade_min/grade_max and
--             lets the operator choose which vocabulary to publish in.
--   room    - the roster email prefers the program's own room and falls back to
--             the venue default (program_locations.room_number). Camps had no
--             room of their own, so every camp at a multi-room venue emailed the
--             venue default even when it was wrong.
--   blurb   - short_description is the line the public catalog puts under the
--             title. Camps have nowhere to put one.
--   partner-run registration - camp_sessions already had runs_own_registration
--             and nothing else: no URL to send families to and no way to say
--             "list it but do not sell it". programs carries all three together,
--             and one without the other two cannot express the case.
--
-- Deliberately NOT mirrored: photo_url and instructor_guide_url. Both exist on
-- programs, but the program wizard does not write either, so adding the columns
-- here would be adding storage nothing fills.
--
-- All additive and nullable (or defaulted false), so the table reads exactly as
-- before until the form starts writing them.

alter table public.camp_sessions
  add column if not exists room text,
  add column if not exists short_description text,
  add column if not exists age_format text,
  add column if not exists grade_min integer,
  add column if not exists grade_max integer,
  add column if not exists external_registration_url text,
  add column if not exists list_in_public_catalog boolean not null default false;

comment on column public.camp_sessions.age_format is
  'Which vocabulary this camp publishes its audience in: "grade" or "age". NULL means neither was stated. Mirrors programs.age_format.';
comment on column public.camp_sessions.room is
  'Room for THIS camp, distinct from the venue default on program_locations.room_number. The roster email prefers this and falls back to that.';

-- Same shape as programs_age_format_check / programs_grade_range_valid. The age
-- pair (ages_min/ages_max) had NO range check on camps at all, which programs has
-- had all along - a camp for ages 12 to 4 was storable. Added here so both
-- vocabularies are guarded the same way.
--
-- NOT VALID is deliberate on the age check: it guards every future write without
-- failing the migration on a row that is already wrong. Verified before writing
-- that no prod or staging row violates it, so this validates cleanly - the flag
-- is belt and braces, not cover for known-bad data.
alter table public.camp_sessions
  drop constraint if exists camp_sessions_age_format_check;
alter table public.camp_sessions
  add constraint camp_sessions_age_format_check
  check (age_format is null or age_format in ('grade', 'age'));

alter table public.camp_sessions
  drop constraint if exists camp_sessions_grade_range_valid;
alter table public.camp_sessions
  add constraint camp_sessions_grade_range_valid
  check (grade_min is null or grade_max is null or grade_min <= grade_max);

alter table public.camp_sessions
  drop constraint if exists camp_sessions_ages_range_valid;
alter table public.camp_sessions
  add constraint camp_sessions_ages_range_valid
  check (ages_min is null or ages_max is null or ages_min <= ages_max) not valid;

alter table public.camp_sessions
  validate constraint camp_sessions_ages_range_valid;
