-- Task A: availability-aware sub suggestions.
-- Returns, for one org + one date, every instructor who has an availability
-- SIGNAL on that date: they are booked (already teaching an afterschool class
-- that recurs on that weekday, at a camp that day, or confirmed as a sub that
-- day) and/or they have marked that exact date off. Instructors with NO signal
-- are simply absent from the result = free that day.
--
-- The modal ranks: absent (available) first, marked-off next, booked
-- ("conflict") last. Nothing is hard-hidden (sub pools are small); this only
-- ranks + flags. See docs/handoffs/sub-availability-and-multi-offer.md (Task A).
--
-- SECURITY INVOKER: runs with the caller's rights, so the org-scoped SELECT RLS
-- policies on every table it reads (is_org_member / org_members_read_*) do the
-- tenant isolation. p_org is passed by the caller but a foreign org just yields
-- zero rows under RLS. No service role, no hardcoded tenant.

CREATE OR REPLACE FUNCTION public.sub_availability_on_date(p_org uuid, p_date date)
RETURNS TABLE (
  instructor_id  uuid,
  is_booked      boolean,
  booked_reason  text,   -- 'teaching' | 'camp' | 'subbing' (highest-priority signal)
  is_marked_off  boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH d AS (
    SELECT p_date AS dt, EXTRACT(DOW FROM p_date)::int AS dow
  ),
  names AS (
    SELECT
      (ARRAY['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])[(SELECT dow FROM d) + 1] AS lname,
      (ARRAY['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'])[(SELECT dow FROM d) + 1] AS cname
  ),
  -- Afterschool: assigned to a program that recurs on this weekday and whose
  -- run covers this date. If end_date is null, derive the tail from the session
  -- count (weekly cadence).
  booked_program AS (
    SELECT DISTINCT pa.instructor_id
    FROM program_assignments pa
    JOIN programs pr ON pr.id = pa.program_id
    WHERE pa.organization_id = p_org
      AND COALESCE(pa.status, '') <> 'declined'
      AND pr.day_of_week = (SELECT cname FROM names)
      AND (SELECT dt FROM d) >= pr.first_session_date
      AND (SELECT dt FROM d) <= COALESCE(
            pr.end_date,
            pr.first_session_date + ((GREATEST(COALESCE(pr.session_count, pr.sessions, 1), 1) - 1) * 7)
          )
  ),
  -- Camp: assigned to a camp session running that date, on a class day (or
  -- class_days unset = assume it runs).
  booked_camp AS (
    SELECT DISTINCT ca.instructor_id
    FROM camp_assignments ca
    JOIN camp_sessions cs ON cs.id = ca.camp_session_id
    WHERE ca.organization_id = p_org
      AND COALESCE(ca.status, '') <> 'declined'
      AND (SELECT dt FROM d) >= cs.starts_on
      AND (SELECT dt FROM d) <= cs.ends_on
      AND (cs.class_days IS NULL OR (SELECT lname FROM names) = ANY(cs.class_days))
  ),
  -- Already the CONFIRMED sub for another slot that day. Pending offers are not
  -- a hard conflict (they may decline) and become common with multi-offer.
  booked_sub AS (
    SELECT DISTINCT s.sub_instructor_id AS instructor_id
    FROM assignment_substitutions s
    WHERE s.organization_id = p_org
      AND s.date = (SELECT dt FROM d)
      AND s.status IN ('confirmed', 'taught')
      AND s.sub_instructor_id IS NOT NULL
  ),
  off_afterschool AS (
    SELECT DISTINCT ita.instructor_id
    FROM instructor_term_availability ita
    WHERE ita.organization_id = p_org
      AND (SELECT dt FROM d) = ANY(ita.unavailable_dates)
  ),
  off_camp AS (
    SELECT DISTINCT ia.instructor_id
    FROM instructor_availability ia
    WHERE ia.organization_id = p_org
      AND (SELECT dt FROM d) = ANY(ia.unavailable_dates)
  ),
  signals AS (
    SELECT instructor_id, 'booked'::text AS kind, 'teaching'::text AS reason FROM booked_program
    UNION ALL SELECT instructor_id, 'booked', 'camp'    FROM booked_camp
    UNION ALL SELECT instructor_id, 'booked', 'subbing' FROM booked_sub
    UNION ALL SELECT instructor_id, 'off',    'off'     FROM off_afterschool
    UNION ALL SELECT instructor_id, 'off',    'off'     FROM off_camp
  )
  SELECT
    s.instructor_id,
    bool_or(s.kind = 'booked') AS is_booked,
    (ARRAY_AGG(s.reason ORDER BY CASE s.reason
        WHEN 'teaching' THEN 1 WHEN 'camp' THEN 2 WHEN 'subbing' THEN 3 ELSE 9 END)
      FILTER (WHERE s.kind = 'booked'))[1] AS booked_reason,
    bool_or(s.kind = 'off') AS is_marked_off
  FROM signals s
  WHERE s.instructor_id IS NOT NULL
  GROUP BY s.instructor_id;
$$;

REVOKE ALL ON FUNCTION public.sub_availability_on_date(uuid, date) FROM public;
GRANT EXECUTE ON FUNCTION public.sub_availability_on_date(uuid, date) TO authenticated;
