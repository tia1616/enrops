-- The sub picker had the same time-blind bug as the after-school board.
--
-- sub_availability_on_date() marked an instructor is_working / 'teaching' if they
-- held ANY class on that weekday inside the date range -- no time comparison at
-- all. So the instructor teaching 12:15-1:15 was filed under "already teaching an
-- after-school class that day" and pushed into the picker's "Marked off or
-- already working" group when you were trying to fill a 3:25 slot. Same root
-- cause as 20260818a, different surface. Jessica, 2026-08-18: "these rules should
-- go for sending out substitute invites as well".
--
-- Now a same-day booking only makes someone unavailable when its window actually
-- OVERLAPS the class being covered. A non-overlapping booking leaves them
-- pickable, and a gap under 60 minutes sets the new tight_gap flag so the modal
-- can flag the drive without hiding them.
--
-- Fail closed, exactly as the board does: if either window is unreadable the
-- booking counts as a conflict. The existing strict regex is reused for that --
-- it demands an explicit AM/PM, so '2:30' yields NULL rather than 2:30am. See
-- 20260818a's note on why that matters once a location guard is gone.
--
-- Camp bookings now compare real camp_sessions.start_time/end_time (both are
-- `time` columns). A camp with no times set stays a conflict, which is the old
-- behaviour and the conservative side.
--
-- Sub bookings resolve their window through parent_assignment_id +
-- parent_assignment_type, so an instructor already subbing 8:00-9:00 no longer
-- blocks them from a 3:25 class.
--
-- RETURN TYPE CHANGES (tight_gap is new), so this is a DROP + CREATE, not a
-- CREATE OR REPLACE. Grants measured off prod before writing this and restored
-- verbatim below: postgres, anon, authenticated, service_role all held EXECUTE.
-- Both statements run in one transaction, so the function is never missing to a
-- concurrent caller. An older frontend simply ignores the extra column.

drop function if exists public.sub_availability_on_date(uuid, date, text, uuid);

CREATE OR REPLACE FUNCTION public.sub_availability_on_date(p_org uuid, p_date date, p_parent_type text, p_parent_assignment_id uuid)
 RETURNS TABLE(instructor_id uuid, is_working boolean, working_reason text, is_date_off boolean, day_time_match text, out_of_area boolean, tight_gap boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH d AS (
    SELECT p_date AS dt, EXTRACT(DOW FROM p_date)::int AS dow
  ),
  wk AS (
    SELECT
      (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[(SELECT dow FROM d) + 1] AS key3,
      (ARRAY['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])[(SELECT dow FROM d) + 1] AS lname
  ),
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
        WHERE ca.id = p_parent_assignment_id)                                       AS target_session_type,
      (SELECT cs.start_time
         FROM camp_assignments ca JOIN camp_sessions cs ON cs.id = ca.camp_session_id
        WHERE ca.id = p_parent_assignment_id)                                       AS target_camp_start,
      (SELECT cs.end_time
         FROM camp_assignments ca JOIN camp_sessions cs ON cs.id = ca.camp_session_id
        WHERE ca.id = p_parent_assignment_id)                                       AS target_camp_end
  ),
  -- The window of the class we are covering. NULL on either end means we cannot
  -- compare, and every same-day booking then counts as a conflict.
  target_win AS (
    SELECT
      CASE WHEN p_parent_type = 'camp' THEN (SELECT target_camp_start FROM tgt)
           ELSE (SELECT target_time FROM tgt) END AS ts,
      CASE WHEN p_parent_type = 'camp' THEN (SELECT target_camp_end FROM tgt)
           ELSE (SELECT target_end_time FROM tgt) END AS te
  ),
  -- Every other thing this instructor is booked on that date, WITH its window.
  booked AS (
    SELECT pa.instructor_id, 'teaching'::text AS reason, 1 AS pri,
           CASE WHEN pr.start_time ~* '^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$'
                THEN to_timestamp(pr.start_time, 'HH12:MI AM')::time END AS s,
           CASE WHEN pr.end_time ~* '^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$'
                THEN to_timestamp(pr.end_time, 'HH12:MI AM')::time END AS e
    FROM program_assignments pa
    JOIN programs pr ON pr.id = pa.program_id
    WHERE pa.organization_id = p_org
      AND COALESCE(pa.status, '') <> 'declined'
      -- CASE FIX, and it is load-bearing. programs.day_of_week is stored
      -- capitalized ("Monday") on BOTH environments -- verified 2026-08-18, 116/116
      -- rows on prod, every row on staging -- while wk.lname is lowercase. So
      -- `pr.day_of_week = 'monday'` matched NOTHING, and the sub picker's "already
      -- teaching an after-school class that day" has never once fired on prod.
      -- Without this line the time-aware logic above would be dead code for
      -- programs. lower(btrim()) is the same idiom the assignment triggers and the
      -- board already use. camp_sessions.class_days IS lowercase, so the camp
      -- branch below was never affected and is left alone.
      AND lower(btrim(pr.day_of_week)) = (SELECT lname FROM wk)
      AND (SELECT dt FROM d) >= pr.first_session_date
      AND (SELECT dt FROM d) <= COALESCE(
            pr.end_date,
            pr.first_session_date + ((GREATEST(COALESCE(pr.session_count, pr.sessions, 1), 1) - 1) * 7)
          )
    UNION ALL
    SELECT ca.instructor_id, 'camp', 2, cs.start_time, cs.end_time
    FROM camp_assignments ca
    JOIN camp_sessions cs ON cs.id = ca.camp_session_id
    WHERE ca.organization_id = p_org
      AND COALESCE(ca.status, '') <> 'declined'
      AND (SELECT dt FROM d) >= cs.starts_on
      AND (SELECT dt FROM d) <= cs.ends_on
      AND (cs.class_days IS NULL OR lower((SELECT lname FROM wk)) = ANY(cs.class_days))
    UNION ALL
    SELECT s.sub_instructor_id, 'subbing', 3,
           COALESCE(
             CASE WHEN spr.start_time ~* '^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$'
                  THEN to_timestamp(spr.start_time, 'HH12:MI AM')::time END,
             scs.start_time),
           COALESCE(
             CASE WHEN spr.end_time ~* '^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$'
                  THEN to_timestamp(spr.end_time, 'HH12:MI AM')::time END,
             scs.end_time)
    FROM assignment_substitutions s
    LEFT JOIN program_assignments spa
           ON spa.id = s.parent_assignment_id AND s.parent_assignment_type = 'program'
    LEFT JOIN programs spr ON spr.id = spa.program_id
    LEFT JOIN camp_assignments sca
           ON sca.id = s.parent_assignment_id AND s.parent_assignment_type = 'camp'
    LEFT JOIN camp_sessions scs ON scs.id = sca.camp_session_id
    WHERE s.organization_id = p_org
      AND s.date = (SELECT dt FROM d)
      AND s.status IN ('confirmed', 'taught')
      AND s.sub_instructor_id IS NOT NULL
  ),
  cmp AS (
    SELECT b.instructor_id, b.reason, b.pri,
      (
        (SELECT ts FROM target_win) IS NULL
        OR (SELECT te FROM target_win) IS NULL
        OR b.s IS NULL OR b.e IS NULL
        OR ((SELECT ts FROM target_win) < b.e AND b.s < (SELECT te FROM target_win))
      ) AS is_conflict,
      CASE
        WHEN b.s IS NOT NULL AND b.e IS NOT NULL
         AND (SELECT ts FROM target_win) IS NOT NULL
         AND (SELECT te FROM target_win) IS NOT NULL
        THEN CASE
               WHEN b.s >= (SELECT te FROM target_win)
                 THEN EXTRACT(EPOCH FROM (b.s - (SELECT te FROM target_win))) / 60
               ELSE EXTRACT(EPOCH FROM ((SELECT ts FROM target_win) - b.e)) / 60
             END
      END AS gap_min
    FROM booked b
    WHERE b.instructor_id IS NOT NULL
  ),
  working AS (
    SELECT DISTINCT ON (instructor_id) instructor_id, reason
    FROM cmp
    WHERE is_conflict
    ORDER BY instructor_id, pri
  ),
  tight AS (
    SELECT DISTINCT instructor_id
    FROM cmp
    WHERE NOT is_conflict AND gap_min IS NOT NULL AND gap_min < 60
  ),
  off_dates AS (
    SELECT instructor_id FROM instructor_term_availability
      WHERE organization_id = p_org AND (SELECT dt FROM d) = ANY(unavailable_dates)
    UNION
    SELECT instructor_id FROM instructor_availability
      WHERE organization_id = p_org AND (SELECT dt FROM d) = ANY(unavailable_dates)
  ),
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
    ) AS out_of_area,
    (t.instructor_id IS NOT NULL AND w.instructor_id IS NULL) AS tight_gap
  FROM instructors i
  LEFT JOIN working w      ON w.instructor_id = i.id
  LEFT JOIN tight t        ON t.instructor_id = i.id
  LEFT JOIN off_dates o    ON o.instructor_id = i.id
  LEFT JOIN ita_latest il  ON il.instructor_id = i.id
  LEFT JOIN ia_latest ic   ON ic.instructor_id = i.id
  WHERE i.organization_id = p_org
    AND i.is_active IS DISTINCT FROM false;
$function$;

-- Restore the grants the DROP took with it. Measured off prod 2026-08-18: exactly
-- postgres, anon, authenticated, service_role -- and NOT public.
--
-- The REVOKE is not decoration. Postgres grants EXECUTE to PUBLIC on every newly
-- created function, so the CREATE above silently re-adds a grant the original did
-- not have. Verified on staging after applying: the grant list came back as
-- PUBLIC + the four, so it is measured, not theoretical. It happens to add no
-- reach here (this function is STABLE, not SECURITY DEFINER, so it runs as the
-- caller under RLS, and anon already held EXECUTE) -- but leaving it would be an
-- unreviewed privilege widening, which is how the districts_public hole got in.
--
-- NOT changed here, deliberately: 20260723b (the migration that created this
-- signature) granted EXECUTE to `authenticated` ONLY. The anon / service_role
-- grants live on prod today because schema DEFAULT PRIVILEGES added them at
-- creation time -- the same mechanism behind the parked anon-write work. This
-- migration therefore reproduces PROD AS IT IS rather than as 20260723b intended.
-- Tightening it is a security decision that belongs with that parked review, not
-- smuggled into a scheduling fix. The only consumer found by grep is
-- AssignSubModal.jsx, i.e. an authenticated admin; no edge function calls it.
REVOKE EXECUTE ON FUNCTION public.sub_availability_on_date(uuid, date, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.sub_availability_on_date(uuid, date, text, uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.sub_availability_on_date(uuid, date, text, uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.sub_availability_on_date(uuid, date, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sub_availability_on_date(uuid, date, text, uuid) TO service_role;
