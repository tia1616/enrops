-- 20260716_early_release_weekday_cache.sql
--
-- Code review (altitude angle) flagged that resolve_district_early_release_
-- exceptions() recomputes "is this weekday consistently early-release all
-- year" from scratch on EVERY call (a full generate_series scan over the
-- school year, ~180-260 rows) - but that classification is a property of the
-- (district_calendars row, weekday) pair, not of the program being resolved.
-- It only changes when someone edits a calendar's early_release_dates /
-- no_school_dates / school-year bounds - rare - yet it was being recomputed
-- on every derive/preview call, for every program, on every schedule render.
--
-- Jessica (2026-07-16): fix this now rather than let it become a real cost as
-- more districts/programs are onboarded.
--
-- This computes the classification ONCE, at write time (INSERT/UPDATE of a
-- district_calendars row), caches it as consistent_early_release_weekdays
-- (which Postgres DOW values, 0=Sun..6=Sat, are 100% early-release all year
-- for this calendar), and makes resolve_district_early_release_exceptions a
-- cheap array-membership check instead of a per-call scan.

-- ──────────────────────────────────────────────────────────────────────
-- Pure function: given a calendar's date range + jsonb date columns, which
-- weekdays (0=Sun..6=Sat) are early-release 100% of the school year?
-- Same filters as the per-call check it replaces (bounded to school year,
-- deduped, excluding dates that are also holidays).
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION compute_consistent_early_release_weekdays(
  p_first_day_of_school DATE,
  p_last_day_of_school DATE,
  p_no_school_dates JSONB,
  p_early_release_dates JSONB
)
RETURNS INTEGER[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_holiday_dates DATE[];
  v_result INTEGER[] := '{}';
  wd INTEGER;
  v_total INTEGER;
  v_early DATE[];
BEGIN
  IF p_first_day_of_school IS NULL OR p_last_day_of_school IS NULL THEN
    RETURN '{}';
  END IF;

  v_holiday_dates := ARRAY(
    SELECT (elem->>'date')::date
    FROM jsonb_array_elements(COALESCE(p_no_school_dates, '[]'::jsonb)) AS elem
    WHERE elem->>'date' IS NOT NULL
  );

  FOR wd IN 0..6 LOOP
    SELECT count(*)
    INTO v_total
    FROM generate_series(p_first_day_of_school, p_last_day_of_school, interval '1 day') AS gs(d)
    WHERE EXTRACT(DOW FROM gs.d) = wd
      AND NOT (gs.d::date = ANY(v_holiday_dates));

    v_early := ARRAY(
      SELECT DISTINCT (elem->>'date')::date
      FROM jsonb_array_elements(COALESCE(p_early_release_dates, '[]'::jsonb)) AS elem
      WHERE elem->>'date' IS NOT NULL
        AND (elem->>'date')::date BETWEEN p_first_day_of_school AND p_last_day_of_school
        AND EXTRACT(DOW FROM (elem->>'date')::date) = wd
        AND NOT ((elem->>'date')::date = ANY(v_holiday_dates))
    );

    IF v_total > 0 AND v_total = COALESCE(array_length(v_early, 1), 0) THEN
      v_result := v_result || wd;
    END IF;
  END LOOP;

  RETURN v_result;
END;
$func$;

COMMENT ON FUNCTION compute_consistent_early_release_weekdays(DATE, DATE, JSONB, JSONB) IS
  'Pure function: which weekdays (0=Sun..6=Sat) are early-release 100% of a calendar''s school year. Used at write time by the district_calendars trigger to populate consistent_early_release_weekdays, so resolve_district_early_release_exceptions() reads it as a cheap array check instead of rescanning the school year on every program/call.';

-- ──────────────────────────────────────────────────────────────────────
-- Cache column + trigger to keep it current on write
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE district_calendars
  ADD COLUMN IF NOT EXISTS consistent_early_release_weekdays INTEGER[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN district_calendars.consistent_early_release_weekdays IS
  'Cached at write time by trg_district_calendars_consistent_weekdays: which weekdays (0=Sun..6=Sat) are early-release 100% of this calendar''s school year (e.g. every Thursday). A program meeting on one of these weekdays is NOT skipped for early release - that is the location''s normal schedule, not a closure.';

CREATE OR REPLACE FUNCTION district_calendars_set_consistent_early_release_weekdays()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $trg$
BEGIN
  NEW.consistent_early_release_weekdays := compute_consistent_early_release_weekdays(
    NEW.first_day_of_school, NEW.last_day_of_school, NEW.no_school_dates, NEW.early_release_dates
  );
  RETURN NEW;
END;
$trg$;

DROP TRIGGER IF EXISTS trg_district_calendars_consistent_weekdays ON district_calendars;
CREATE TRIGGER trg_district_calendars_consistent_weekdays
  BEFORE INSERT OR UPDATE OF first_day_of_school, last_day_of_school, no_school_dates, early_release_dates
  ON district_calendars
  FOR EACH ROW
  EXECUTE FUNCTION district_calendars_set_consistent_early_release_weekdays();

-- Backfill existing rows (trigger only fires going forward on the tracked
-- columns; this touches early_release_dates to itself so the trigger runs).
UPDATE district_calendars SET early_release_dates = early_release_dates;

-- ──────────────────────────────────────────────────────────────────────
-- Rewire resolve_district_early_release_exceptions to use the cached column
-- (array-membership check) instead of a per-call generate_series scan.
-- Behavior is unchanged - same classification, computed once at write time.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION resolve_district_early_release_exceptions(
  p_org_id UUID,
  p_location_id UUID,
  p_term TEXT,
  p_weekday INTEGER
)
RETURNS DATE[]
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_result DATE[] := '{}';
  dc RECORD;
  v_holiday_dates DATE[];
BEGIN
  IF p_weekday IS NULL THEN
    RETURN '{}';
  END IF;

  FOR dc IN SELECT * FROM matching_district_calendars(p_org_id, p_location_id, p_term) LOOP
    IF p_weekday = ANY(dc.consistent_early_release_weekdays) THEN
      CONTINUE; -- normal schedule at this location - not an exception to skip
    END IF;

    IF dc.first_day_of_school IS NULL OR dc.last_day_of_school IS NULL THEN
      CONTINUE;
    END IF;

    v_holiday_dates := ARRAY(
      SELECT (elem->>'date')::date
      FROM jsonb_array_elements(dc.no_school_dates) AS elem
      WHERE elem->>'date' IS NOT NULL
    );

    v_result := v_result || ARRAY(
      SELECT DISTINCT (elem->>'date')::date
      FROM jsonb_array_elements(dc.early_release_dates) AS elem
      WHERE elem->>'date' IS NOT NULL
        AND (elem->>'date')::date BETWEEN dc.first_day_of_school AND dc.last_day_of_school
        AND EXTRACT(DOW FROM (elem->>'date')::date) = p_weekday
        AND NOT ((elem->>'date')::date = ANY(v_holiday_dates))
    );
  END LOOP;

  RETURN COALESCE(v_result, '{}'::date[]);
END;
$func$;

COMMENT ON FUNCTION resolve_district_early_release_exceptions(UUID, UUID, TEXT, INTEGER) IS
  'Early-release dates that fall on a program''s weekday and are EXCEPTIONS to that location''s normal pattern (some weeks early, some not) - these get skipped like a holiday. Reads district_calendars.consistent_early_release_weekdays (cached at write time) to skip any weekday that is early-release 100% of the school year - that is the location''s normal schedule, not something to skip, and needs a program time correction instead.';

GRANT EXECUTE ON FUNCTION resolve_district_early_release_exceptions(UUID, UUID, TEXT, INTEGER) TO authenticated;
