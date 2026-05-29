-- 20260529_program_locations_closure_dates.sql
--
-- District / venue closure dates for FA26 afterschool session derivation.
--
-- Why this column lives on program_locations and not on a dedicated
-- districts table: today every J2S location is its own row. A proper
-- districts table is queued (see backlog 2026-05-26 "Districts table
-- follow-up") but pulling that refactor in here would balloon scope.
--
-- When the districts table lands, this column gets backfilled from
-- `districts.closure_dates` per location via a join, and this column
-- becomes a denormalized cache or gets dropped. The session-derivation
-- function below reads from here today; updating the function later is
-- a single-place change.
--
-- Examples of what goes in here for a Portland Public Schools site:
--   {'2026-09-01','2026-11-11','2026-11-26','2026-11-27',...}
-- ie. teacher planning days, holidays, district closures — anything where
-- school is not in session and therefore the afterschool program does
-- not meet that week.

ALTER TABLE program_locations
  ADD COLUMN IF NOT EXISTS closure_dates DATE[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN program_locations.closure_dates IS
  'Dates the location is closed (school holidays, teacher planning days, district closures). derive_program_session_dates() subtracts these from generated session dates so afterschool programs skip them. Will be replaced by a districts table join in a future refactor.';

-- ──────────────────────────────────────────────────────────────────────
-- derive_program_session_dates(program_id) → DATE[]
--
-- Returns the chronological list of dates a program meets, derived from:
--   programs.first_session_date  (start)
--   programs.session_count       (how many sessions)
--   programs.day_of_week         (used only as a sanity check today;
--                                 derivation assumes weekly cadence
--                                 starting on first_session_date)
--   program_locations.closure_dates  (skipped)
--
-- Behavior:
--   - Generates session_count + closure_count candidate weekly dates,
--     then filters out any that fall on a closure_date. Returns the
--     first session_count surviving dates.
--   - If the program runs out of weeks before hitting session_count
--     (extreme closure load), returns what it has + leaves the rest to
--     the caller to surface as "schedule extends beyond planned weeks."
--   - Returns empty array if first_session_date or session_count is NULL.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION derive_program_session_dates(p_program_id UUID)
RETURNS DATE[]
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_first_date  DATE;
  v_count       INTEGER;
  v_location_id UUID;
  v_closures    DATE[];
  v_result      DATE[] := '{}';
  v_candidate   DATE;
  v_max_lookups INTEGER;
  v_added       INTEGER := 0;
  i             INTEGER := 0;
BEGIN
  SELECT p.first_session_date, p.session_count, p.program_location_id
    INTO v_first_date, v_count, v_location_id
  FROM programs p
  WHERE p.id = p_program_id;

  IF v_first_date IS NULL OR v_count IS NULL OR v_count <= 0 THEN
    RETURN '{}';
  END IF;

  SELECT COALESCE(pl.closure_dates, '{}')
    INTO v_closures
  FROM program_locations pl
  WHERE pl.id = v_location_id;

  -- Bound the loop so a runaway closure list can't spin forever.
  -- Programs cap at ~36 sessions in real use; allow 2x headroom for
  -- closure-heavy terms.
  v_max_lookups := v_count * 2 + COALESCE(array_length(v_closures, 1), 0);

  WHILE v_added < v_count AND i < v_max_lookups LOOP
    v_candidate := v_first_date + (i * 7);
    IF NOT (v_candidate = ANY(v_closures)) THEN
      v_result := v_result || v_candidate;
      v_added := v_added + 1;
    END IF;
    i := i + 1;
  END LOOP;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION derive_program_session_dates(UUID) IS
  'Returns the chronological list of dates an afterschool program meets, skipping closure_dates on its program_location. Used by the instructor portal, the admin schedule, and pay calc. Runs as caller (SECURITY INVOKER) so RLS on programs + program_locations gates access — a caller can only derive dates for programs they can see.';

GRANT EXECUTE ON FUNCTION derive_program_session_dates(UUID) TO authenticated;
