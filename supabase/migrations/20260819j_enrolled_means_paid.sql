-- "Enrolled" means children who have paid. Held seats are a SEPARATE number.
--
-- Jessica, 2026-08-19: "only count enrolled people who've paid."
--
-- THE NUMBER WAS DOING TWO JOBS AND THEY PULL APART.
--
--   "How many children are in this class"  - what an operator reads on a screen.
--   "How many seats are unavailable"       - what stops the class being oversold.
--
-- Until now both came from registration_holds_seat(), so `enrolled` also counted a
-- checkout in flight, an ACH transfer clearing, and (since 20260819f) a waitlisted family
-- holding an unexpired invite. None of those children are in the class. An operator
-- reading "10 enrolled" for a class with 9 actual kids plans staffing, orders kits and
-- bills a school partner off a number that includes somebody who may never accept.
--
-- But the anti-oversell number MUST keep counting those seats. Split them:
--
--   enrolled     = paid or confirmed          <- the honest count, safe to read
--   seats_taken  = registration_holds_seat()  <- the enforced count, safe to sell against
--   spots_remaining = max_capacity - seats_taken
--
-- spots_remaining is deliberately derived from seats_taken, NOT from enrolled. Deriving
-- it from enrolled would advertise a seat that a family is mid-checkout for, which is the
-- exact oversell this whole branch exists to prevent. Nothing in the app reads
-- spots_remaining today (grepped: only this file, the 2026-06-04 baseline dump and older
-- migrations mention it), so this makes it correct before anything depends on it.
--
-- WHY "paid or confirmed" AND NOT payment_status = 'paid'.
-- Checked against PROD before choosing: 328 un-cancelled registrations are
-- status='confirmed' with payment_status='unpaid', all J2S, May-July 2026, none of them
-- zero-price. They are the Squarespace-era children, paid outside Stripe. A strict
-- payment_status='paid' test would have erased 328 of 588 real enrolled kids from every
-- count on the platform. "paid or confirmed" is also already the definition used by
-- ProgramRoster, ProgramsCalendar and email-program-roster, so this makes the database
-- agree with the three screens rather than inventing a fourth answer.
--
-- THE EQUIVALENCE PROBE FROM 20260819a IS NOW INTENTIONALLY FALSE.
-- That migration pinned `program_enrollment.enrolled = program_seat_counts.seats_taken`
-- and said the two must never drift. That was right when both meant "occupies a seat".
-- It is wrong now, on purpose. The replacement invariant, which still holds:
--
--     select count(*) from program_enrollment v
--       join program_seat_counts() f on f.program_id = v.program_id
--      where v.seats_taken is distinct from f.seats_taken;   -- must be 0
--
-- Do not "fix" enrolled back to match seats_taken. The difference IS the feature.

create or replace view public.program_enrollment
with (security_invoker = on)
as
 select p.id as program_id, p.curriculum, pl.name as program_location_name,
    pl.name as school_name, p.day_of_week, p.max_capacity,
    -- Children actually in the class.
    count(r.id) filter (
      where r.cancelled_at is null
        and (r.payment_status = 'paid' or r.status = 'confirmed')
    ) as enrolled,
    -- Derived from the ENFORCED number, never from enrolled.
    --
    -- CLAMPED AT ZERO. A class CAN hold more seats than its capacity - an operator lowers
    -- max_capacity after families have enrolled, or a kit shortage shrinks a class - and
    -- the raw subtraction then goes negative. This is the parent-facing "spots available"
    -- number, and "-1 spots left" is not a thing a parent can act on. Zero is the true
    -- answer to "how many can I buy".
    -- Over-subscription is NOT hidden by this: seats_taken and max_capacity are both
    -- returned raw, so seats_taken > max_capacity still says so plainly to an operator.
    greatest(0, p.max_capacity - count(r.id) filter (where registration_holds_seat(r))) as spots_remaining,
    -- Chairs that cannot be sold: the same rule create-registration enforces.
    --
    -- APPENDED LAST, and that ordering is load-bearing rather than cosmetic. CREATE OR
    -- REPLACE VIEW can only ADD columns at the end - putting seats_taken between
    -- enrolled and spots_remaining fails with 42P16 ("cannot change name of view
    -- column"). The alternative, DROP + CREATE, would silently drop the view's GRANTs:
    -- anon and authenticated hold SELECT on this view and the parent-facing catalog
    -- depends on it. A grant lost that way fails for nobody who tests as an admin.
    count(r.id) filter (where registration_holds_seat(r)) as seats_taken
   from programs p
     join program_locations pl on p.program_location_id = pl.id
     left join registrations r on r.program_id = p.id
  group by p.id, p.curriculum, pl.name, p.day_of_week, p.max_capacity;

comment on view public.program_enrollment is
  'Public aggregate counts for the parent-facing "spots available" UI and the admin schedule. THREE DIFFERENT NUMBERS, on purpose: enrolled = children actually in the class (payment_status=paid OR status=confirmed, matching ProgramRoster / ProgramsCalendar / email-program-roster); seats_taken = chairs that cannot be sold, via registration_holds_seat(), which also counts a live checkout, an ACH transfer clearing, and a waitlisted family holding an unexpired invite; spots_remaining = max_capacity - seats_taken, derived from the ENFORCED number so a seat mid-checkout is never advertised. enrolled and seats_taken are MEANT to differ - see 20260819j before making them agree. security_invoker = on, so RLS applies to the caller and anon sees zeros by design (2026-06-06 hotfix). Returns NO PII.';
