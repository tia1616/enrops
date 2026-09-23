-- The single-winner guard now covers 'taught' as well as 'confirmed'.
--
-- THE HOLE. 20260723c created the guard as a PARTIAL unique index WHERE status
-- = 'confirmed'. A sub who actually turns up is then flipped confirmed ->
-- 'taught' by confirm-sub-delivery, which takes that row OUT of the index and
-- frees the slot. While the plain UNIQUE (parent_assignment_id, type, date) is
-- still in place nothing can exploit that, but chunk 2 removes it - and from
-- that moment a class-day can legally hold one 'taught' row AND one 'confirmed'
-- row, i.e. two different people both recorded as having covered one day.
--
-- WHAT THAT COSTS, and it is money. v_effective_pay_lines LEFT JOINs
-- assignment_substitutions on (parent_assignment_id, type, date) filtered to
-- confirmed|taught with no dedupe, so two settled rows fan one session's
-- delivery confirmation out into TWO pay lines - duplicate rows on the payroll
-- screen and an ambiguous payee for pay-instructor. Two people, one class, one
-- day, paid twice.
--
-- It also un-breaks two lookups elsewhere. confirm-session-taught and
-- admin-confirm-session both ask "did a sub cover this day?" with
-- .maybeSingle(), which ERRORS on two rows. With this index the two-row state
-- cannot exist, so both calls are correct by construction rather than by luck.
-- (confirm-session-taught discards that error entirely, which is fixed
-- separately - a guard on a money path must not depend on a state being
-- impossible.)
--
-- SAFE TO TIGHTEN: measured on both databases before applying - ZERO class-days
-- currently hold more than one confirmed-or-taught row (prod: 1 confirmed row
-- in total and 0 taught; staging: 0 taught). So this rejects nothing that
-- exists, and from here it is the database, not a convention, that guarantees
-- one settled sub per class-day.

DROP INDEX IF EXISTS public.assignment_substitutions_one_confirmed_per_slot;

CREATE UNIQUE INDEX assignment_substitutions_one_settled_per_slot
  ON public.assignment_substitutions (parent_assignment_id, parent_assignment_type, date)
  WHERE status IN ('confirmed', 'taught');

COMMENT ON INDEX public.assignment_substitutions_one_settled_per_slot IS
  'One settled substitute per class-day. Covers confirmed AND taught: the winner '
  'moves between those two states, and letting the slot free on that move would '
  'allow a second person to be confirmed for a day somebody has already taught - '
  'which duplicates their pay line. Replaces the confirmed-only index from 20260723c.';
