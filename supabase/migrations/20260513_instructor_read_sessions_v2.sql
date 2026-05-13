-- v2 of the instructor read-sessions fix. The v1 version joined the
-- instructors table inside the policy, but instructors has no RLS policy
-- allowing an instructor to read their own row, so the join collapsed to
-- empty and Kyle (and every other real instructor) still saw "No schedule
-- yet" in the portal.
--
-- The new version relies on camp_assignments' own RLS
-- (instructor_self_assignments_read) which already filters reads to the
-- caller's own published rows. The inner SELECT therefore returns only
-- Kyle's session ids when Kyle is the caller, and the surrounding policy
-- gates camp_sessions reads to those.

DROP POLICY IF EXISTS instructor_self_read_sessions ON camp_sessions;
CREATE POLICY instructor_self_read_sessions ON camp_sessions
  FOR SELECT
  USING (
    id IN (
      SELECT ca.camp_session_id
      FROM camp_assignments ca
      WHERE ca.published_at IS NOT NULL
    )
  );
