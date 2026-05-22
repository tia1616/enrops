-- Instructor Portal v1, Chunk F final step.
--
-- After respond-to-assignment is deployed and the UI calls it, the direct
-- instructor UPDATE path is closed. The edge function (service role) is
-- now the sole instructor write path to camp_assignments -- matches the
-- "edge function is the authorized write path" pattern used for the legal
-- record tables in the contractor portal.
--
-- Instructors keep their SELECT policy on camp_assignments unchanged.
-- Admin write policies on camp_assignments are unaffected.
--
-- Applied 2026-05-22.

drop policy if exists instructor_self_assignments_respond on public.camp_assignments;
