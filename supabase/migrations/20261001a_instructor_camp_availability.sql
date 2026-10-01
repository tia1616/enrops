-- WHICH CAMPS CAN THIS INSTRUCTOR WORK.
--
-- THE GAP THIS CLOSES. The availability survey asks which WEEKDAYS someone can
-- teach and from what time - an after-school question: "Mondays, from 1:00",
-- meaning after dismissal. A break camp runs 9-3 on specific dates, so that
-- answer says nothing useful about it. An operator with a winter camp to staff
-- had no recorded answer to "who can work it" and had to ask by hand.
--
-- KEYED ON THE CAMP, NOT ON A WEEK NUMBER. Jessica, 2026-10-01: "can't there
-- just be added 'week 1, 2' etc to avail survey... and the weeks should align to
-- the program camps i've entered into enrops, right?" - yes, and keying on the
-- camp itself is how they stay aligned. A separate list of weeks would be a
-- second thing to keep in sync, and it would already be wrong for a winter camp
-- that runs Mon-Thu rather than a full week. For summer, where a camp IS a week,
-- listing the camps lists the weeks and names them while it is at it.
--
-- SHAPE: { "<programs.id>": true | false }. An explicit answer per camp, not a
-- list of the ones they ticked, because ABSENT and FALSE are different facts:
--   present/true   they said they can work it
--   present/false  they said they cannot
--   absent         they were never asked - the camp was created after they
--                  submitted. That must not read as "no" on the staffing board,
--                  or a camp added in week two silently looks like nobody is
--                  free for it.
--
-- NOT A NEW TABLE. This is one more answer on the row the instructor already
-- submits for the term, keyed by (organization_id, instructor_id, term) exactly
-- as weekday_availability and unavailable_dates are. A sibling table would key
-- the same way and need its own RLS, its own grants and its own survey write.
--
-- NULLABLE AND INERT. Nothing reads it until the survey asks and the board
-- shows it, so this lands on staging and prod in the same pass ahead of both.

alter table public.instructor_term_availability
  add column if not exists camp_availability jsonb;

comment on column public.instructor_term_availability.camp_availability is
  'Which camps this instructor can work, as {"<programs.id>": true|false}. One explicit answer per camp they were shown. ABSENT means NOT ASKED (the camp was created after they submitted) and must never be read as "cannot" - the staffing board shows it as unanswered. Keyed on the camp rather than a week number so the question cannot drift from the camps the operator actually entered; a camp is the unit that gets assigned, and for summer a camp is a week.';
