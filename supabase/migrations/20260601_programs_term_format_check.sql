-- 20260601_programs_term_format_check.sql
--
-- Enforces the FA##/WI##/SP##/SU## convention on programs.term so that the
-- district-calendar lookup in derive_program_session_dates() can't be
-- silently broken by an accidental rename ("Fall26", "fall 2026", etc.).
--
-- term_to_school_year() maps based on the two-letter prefix + two-digit
-- year. Any other format would return NULL from that function, which means
-- the district calendar would be skipped silently and parents/instructors
-- would see weekly dates that didn't subtract district holidays.
--
-- The constraint allows NULL (some legacy or in-progress programs may
-- not have a term set yet) but rejects any non-conforming string. If a
-- future tenant introduces a new term type, ADD to the regex — don't
-- relax the constraint.
--
-- Verified before applying: all 90 existing programs across all orgs use
-- FA26 / WI27 / SP27, so the constraint will not reject any current row.

ALTER TABLE programs
  ADD CONSTRAINT programs_term_format_check
  CHECK (term IS NULL OR term ~ '^(FA|WI|SP|SU)[0-9]{2}$');

COMMENT ON CONSTRAINT programs_term_format_check ON programs IS
  'Term must match (FA|WI|SP|SU)NN, e.g. FA26 / WI27 / SP27 / SU26. Mirrors term_to_school_year() in 20260601_district_calendars.sql — change both together if the convention is ever extended.';
