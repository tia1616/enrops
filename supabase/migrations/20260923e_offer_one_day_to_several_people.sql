-- A class-day can now be offered to several people at once.
--
-- WHAT COMES OFF. UNIQUE (parent_assignment_id, parent_assignment_type, date)
-- held exactly ONE substitution row per class-day. That single rule is what has
-- made every other limitation necessary:
--   * you could only ever ask one person at a time, and wait;
--   * create-assignment-substitution had to UPSERT onto it, so offering a
--     refused day to the next person OVERWROTE the refusal - the record that
--     anyone had said no was destroyed, and the day went back to reporting
--     "waiting to hear back" with no trace;
--   * and accept_sub_offer, the atomic first-come accept shipped in July, had
--     nothing to arbitrate, so it sat unused.
--
-- WHAT GOES ON IN ITS PLACE. One LIVE offer per person per class-day:
--
--   unique (parent_assignment_id, parent_assignment_type, date, sub_instructor_id)
--     where status = 'pending'
--
-- Partial on 'pending' deliberately. It stops the same person holding two live
-- offers for one day (two emails, two Accept buttons, and a decline that would
-- inflate every "N people" count to a crowd of one), while still allowing a
-- DECLINED row to sit beside a new live one - which is what lets "Ann said no,
-- then said yes when I asked again" be recorded truthfully instead of
-- overwritten.
--
-- WHAT STILL GUARANTEES ONE WINNER: assignment_substitutions_one_settled_per_slot
-- (20260923d), unique per class-day where status is confirmed or taught. Several
-- people may be ASKED; exactly one can end up covering. accept_sub_offer leans on
-- that index to decide a race, and now finally has a caller.
--
-- COUPLED DEPLOY - this migration and TWO functions move together. Both, not
-- one: an earlier draft of this note named only the send, and shipping without
-- the other leaves the first multi-offer day broken in a way nobody can see.
--
--   1. create-assignment-substitution. The old version upserts ON CONFLICT on
--      the constraint dropped here, so dropping it under the old code raises
--      42P10 on the live sub-assign path.
--   2. respond-to-sub-offer. The old version accepts with a bare status update
--      and has no idea two people can hold one day. Ship the migration without
--      it and the FIRST person to accept succeeds, the second trips the
--      single-settled index and gets a raw 500 forever, nobody's losing offer is
--      ever closed out, and every one of them keeps an Accept button that fails.
--
-- ORDER: both functions FIRST, then this migration. That leaves only a brief
-- window where re-offering a day that already holds somebody else's row fails,
-- rather than one where every sub assignment fails or races resolve to nothing.

ALTER TABLE public.assignment_substitutions
  DROP CONSTRAINT IF EXISTS assignment_substitutions_parent_assignment_id_parent_assign_key;

CREATE UNIQUE INDEX IF NOT EXISTS assignment_substitutions_one_live_offer_per_person
  ON public.assignment_substitutions (parent_assignment_id, parent_assignment_type, date, sub_instructor_id)
  WHERE status = 'pending';

COMMENT ON INDEX public.assignment_substitutions_one_live_offer_per_person IS
  'One LIVE offer per person per class-day. Several people may hold offers for the '
  'same day (first to accept wins); nobody may hold two at once. Partial on pending '
  'on purpose, so a declined row survives beside a fresh ask instead of being '
  'overwritten - the refusal is history and the alarm depends on it.';
