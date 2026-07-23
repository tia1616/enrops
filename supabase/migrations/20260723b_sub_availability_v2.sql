-- Task A (v2): rank sub candidates by MATCHING AVAILABILITY, per Jessica's
-- refinement: the suggestions are instructors whose availability matches the
-- class's day AND time and who are not already working that date. Area (the
-- instructor's district preferences vs the class venue's district) is a soft
-- NOTE only, never a filter. See docs/handoffs/sub-availability-and-multi-offer.md.
--
-- v1 (20260723a) only flagged date-conflicts + marked-off dates and returned
-- just flagged rows. v2 resolves the target class's time/session-type/district
-- from the parent assignment and returns a full picture for EVERY active org
-- instructor so the modal can bucket precisely:
--   is_working     - already teaching / at camp / confirmed sub that date
--   is_date_off    - that exact date is in their unavailable_dates
--   day_time_match - 'match' | 'time' | 'day' | 'none'  (availability fit)
--   out_of_area    - class venue's district not in their site_preferences
--
-- Decision (Jessica 2026-07-23): STRICT - only true day+time matches are
-- "suggested"; instructors with no survey on file or a mismatch sit behind the
-- modal's "show everyone". Unknown availability is NOT treated as available.
--
-- Availability sources (verified against live data):
--   afterschool: instructor_term_availability.weekday_availability jsonb,
--                keyed by 3-letter weekday -> { from, until } (24h "HH:MM").
--                program start_time/end_time are 12h text ("2:00 PM").
--   camp:        instructor_availability.session_types text[]
--                ('morning' | 'afternoon' | 'full_day') vs camp_sessions.session_type.
--   area:        instructors.site_preferences->'districts' = array of district
--                NAME strings vs program_locations.district.
--
-- The class start/end time is only parsed when it matches a 12h clock pattern,
-- so a malformed time on one program can never error the whole picker (it just
-- skips the time check for that class).
--
-- SECURITY INVOKER: org-scoped SELECT RLS on every table it reads does the
-- tenant isolation. No service role, no hardcoded tenant.

DROP FUNCTION IF EXISTS public.sub_availability_on_date(uuid, date);

CREATE OR REPLACE FUNCTION public.sub_availability_on_date(
  p_org                  uuid,
  p_date                 date,
  p_parent_type          text,   -- 'program' (afterschool) | 'camp'
  p_parent_assignment_id uuid
)
RETURNS TABLE (
  instructor_id  uuid,
  is_working     boolean,
  working_reason text,     -- 'teaching' | 'camp' | 'subbing'
  is_date_off    boolean,
  day_time_match text,     -- 'match' | 'time' | 'day' | 'none'
  out_of_area    boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH d AS (
    SELECT p_date AS dt, EXTRACT(DOW FROM p_date)::int AS dow
  ),
  wk AS (
    SELECT
      (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[(SELECT dow FROM d) + 1] AS key3,
      (ARRAY['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])[(SELECT dow FROM d) + 1] AS lname
  ),
  -- Resolve the class being subbed. Only the branch matching p_parent_type
  -- finds a row; the other stays NULL.
  tgt AS (
    SELECT
      (SELECT to_timestamp(pr.start_time, 'HH12:MI AM')::time
         FROM program_assignments pa JOIN programs pr ON pr.id = pa.program_id
        WHERE pa.id = p_parent_assignment_id
          AND pr.start_time ~* '^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$')                    AS target_time,
      (SELECT to_timestamp(pr.end_time, 'HH12:MI AM')::time
         FROM program_assignments pa JOIN programs pr ON pr.id = pa.program_id
        WHERE pa.id = p_parent_assignment_id
          AND pr.end_time ~* '^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$')                      AS target_end_time,
      (SELECT lower(trim(pl.district))
         FROM program_assignments pa
         JOIN programs pr ON pr.id = pa.program_id
         JOIN program_locations pl ON pl.id = pr.program_location_id
        WHERE pa.id = p_parent_assignment_id AND pl.district IS NOT NULL)           AS target_district,
      (SELECT cs.session_type
         FROM camp_assignments ca JOIN camp_sessions cs ON cs.id = ca.camp_session_id
        WHERE ca.id = p_parent_assignment_id)                                       AS target_session_type
  ),
  booked_program AS (
    SELECT DISTINCT pa.instructor_id
    FROM program_assignments pa
    JOIN programs pr ON pr.id = pa.program_id
    WHERE pa.organization_id = p_org
      AND COALESCE(pa.status, '') <> 'declined'
      AND pr.day_of_week = (SELECT lname FROM wk)
      AND (SELECT dt FROM d) >= pr.first_session_date
      AND (SELECT dt FROM d) <= COALESCE(
            pr.end_date,
            pr.first_session_date + ((GREATEST(COALESCE(pr.session_count, pr.sessions, 1), 1) - 1) * 7)
          )
  ),
  booked_camp AS (
    SELECT DISTINCT ca.instructor_id
    FROM camp_assignments ca
    JOIN camp_sessions cs ON cs.id = ca.camp_session_id
    WHERE ca.organization_id = p_org
      AND COALESCE(ca.status, '') <> 'declined'
      AND (SELECT dt FROM d) >= cs.starts_on
      AND (SELECT dt FROM d) <= cs.ends_on
      AND (cs.class_days IS NULL OR lower((SELECT lname FROM wk)) = ANY(cs.class_days))
  ),
  booked_sub AS (
    SELECT DISTINCT s.sub_instructor_id AS instructor_id
    FROM assignment_substitutions s
    WHERE s.organization_id = p_org
      AND s.date = (SELECT dt FROM d)
      AND s.status IN ('confirmed', 'taught')
      AND s.sub_instructor_id IS NOT NULL
  ),
  working AS (
    SELECT DISTINCT ON (instructor_id) instructor_id, reason
    FROM (
      SELECT instructor_id, 'teaching'::text AS reason, 1 AS pri FROM booked_program
      UNION ALL SELECT instructor_id, 'camp',    2 FROM booked_camp
      UNION ALL SELECT instructor_id, 'subbing', 3 FROM booked_sub
    ) x
    WHERE instructor_id IS NOT NULL
    ORDER BY instructor_id, pri
  ),
  off_dates AS (
    SELECT instructor_id FROM instructor_term_availability
      WHERE organization_id = p_org AND (SELECT dt FROM d) = ANY(unavailable_dates)
    UNION
    SELECT instructor_id FROM instructor_availability
      WHERE organization_id = p_org AND (SELECT dt FROM d) = ANY(unavailable_dates)
  ),
  -- Latest availability row per instructor (survey answers are fairly stable;
  -- the newest submission is their current stance).
  ita_latest AS (
    SELECT DISTINCT ON (instructor_id) instructor_id, weekday_availability
    FROM instructor_term_availability
    WHERE organization_id = p_org
      AND weekday_availability IS NOT NULL AND weekday_availability <> '{}'::jsonb
    ORDER BY instructor_id, COALESCE(updated_at, submitted_at, created_at) DESC NULLS LAST
  ),
  ia_latest AS (
    SELECT DISTINCT ON (instructor_id) instructor_id, session_types
    FROM instructor_availability
    WHERE organization_id = p_org
      AND session_types IS NOT NULL AND array_length(session_types, 1) > 0
    ORDER BY instructor_id, COALESCE(updated_at, submitted_at, created_at) DESC NULLS LAST
  )
  SELECT
    i.id AS instructor_id,
    (w.instructor_id IS NOT NULL) AS is_working,
    w.reason AS working_reason,
    (o.instructor_id IS NOT NULL) AS is_date_off,
    CASE
      WHEN p_parent_type = 'program' THEN (
        CASE
          WHEN il.weekday_availability IS NULL THEN 'none'
          WHEN NOT jsonb_exists(il.weekday_availability, (SELECT key3 FROM wk)) THEN 'day'
          WHEN (SELECT target_time FROM tgt) IS NOT NULL AND (
                 ((il.weekday_availability -> (SELECT key3 FROM wk) ->> 'from') IS NOT NULL
                    AND (SELECT target_time FROM tgt) < (il.weekday_availability -> (SELECT key3 FROM wk) ->> 'from')::time)
              OR ((il.weekday_availability -> (SELECT key3 FROM wk) ->> 'until') IS NOT NULL
                    AND COALESCE((SELECT target_end_time FROM tgt), (SELECT target_time FROM tgt)) > (il.weekday_availability -> (SELECT key3 FROM wk) ->> 'until')::time)
               ) THEN 'time'
          ELSE 'match'
        END
      )
      WHEN p_parent_type = 'camp' THEN (
        CASE
          WHEN ic.session_types IS NULL THEN 'none'
          WHEN (SELECT target_session_type FROM tgt) IS NULL THEN 'match'
          WHEN (SELECT target_session_type FROM tgt) = ANY(ic.session_types)
            OR ('full_day' = ANY(ic.session_types)
                 AND (SELECT target_session_type FROM tgt) IN ('morning', 'afternoon')) THEN 'match'
          ELSE 'time'
        END
      )
      ELSE 'none'
    END AS day_time_match,
    (
      p_parent_type = 'program'
      AND (SELECT target_district FROM tgt) IS NOT NULL
      AND jsonb_array_length(COALESCE(i.site_preferences -> 'districts', '[]'::jsonb)) > 0
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(i.site_preferences -> 'districts') dd
        WHERE lower(trim(dd)) = (SELECT target_district FROM tgt)
      )
    ) AS out_of_area
  FROM instructors i
  LEFT JOIN working w      ON w.instructor_id = i.id
  LEFT JOIN off_dates o    ON o.instructor_id = i.id
  LEFT JOIN ita_latest il  ON il.instructor_id = i.id
  LEFT JOIN ia_latest ic   ON ic.instructor_id = i.id
  WHERE i.organization_id = p_org
    AND i.is_active IS DISTINCT FROM false;
$$;

REVOKE ALL ON FUNCTION public.sub_availability_on_date(uuid, date, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.sub_availability_on_date(uuid, date, text, uuid) TO authenticated;
