-- An uncapped class must not advertise itself as full.
--
-- `greatest(0, p.max_capacity - <taken>)` looks like a clamp and is also, quietly, a bug.
-- Postgres GREATEST IGNORES NULLS - it returns the largest non-null argument and is NULL
-- only when every argument is NULL. So on a class with no capacity set:
--
--     greatest(0, NULL - 3)  ->  greatest(0, NULL)  ->  0
--
-- Zero, not NULL. Confirmed on staging rather than reasoned about. `spots_remaining = 0` is
-- how "this class is full" is expressed everywhere else, so an uncapped class - which can
-- never be full, and which the capacity gate in create-registration and
-- program_seat_counts both let straight through - would read as having no room left.
--
-- Nothing reads spots_remaining yet, which is the only reason this has cost nothing so far.
-- It is fixed now, before the first reader arrives, because the first reader will be a
-- parent-facing "spots available" label and the failure is silent in both directions: the
-- catalog says full, the gate says come in.
--
-- max_capacity <= 0 GOES THE SAME WAY, and that is the other half of this fix rather than a
-- separate nicety. create-registration treats `max_capacity === null || <= 0` as uncapped
-- and program_seat_counts uses `coalesce(max_capacity, 0) > 0` for is_full, so a class with
-- the cap typed as 0 is already "never full" to the gate. Leaving spots_remaining at 0 for
-- that class would reproduce this exact contradiction one data-entry slip further along.
-- Neither state exists on prod today (checked: zero NULL, zero 0, zero negative), so this
-- changes no live number - it makes the three definitions agree before one appears.
--
-- NULL means "no limit", not "unknown". A reader must not print it as a number: show the
-- class as open, with no count.
--
-- CREATE OR REPLACE, and the column list, order and TYPES are unchanged - null is cast to
-- bigint to match what greatest() returned. Replacing rather than dropping keeps the view's
-- GRANTs: anon and authenticated hold SELECT on it and the parent-facing catalog depends on
-- that, while a DROP would silently take them away and fail for nobody testing as an admin.

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
    -- UNCAPPED IS NULL, NOT ZERO. See the header: greatest() would have turned "no limit"
    -- into "no room". A class with no usable cap has no answer to "how many can I buy",
    -- and NULL is that answer.
    --
    -- CLAMPED AT ZERO WHEN THERE IS A CAP. A class CAN hold more seats than its capacity -
    -- an operator lowers max_capacity after families have enrolled, or a kit shortage
    -- shrinks a class - and the raw subtraction then goes negative. This is the
    -- parent-facing "spots available" number, and "-1 spots left" is not a thing a parent
    -- can act on. Zero is the true answer to "how many can I buy".
    -- Over-subscription is NOT hidden by this: seats_taken and max_capacity are both
    -- returned raw, so seats_taken > max_capacity still says so plainly to an operator.
    case
      when p.max_capacity is null or p.max_capacity <= 0 then null::bigint
      else greatest(0, p.max_capacity - count(r.id) filter (where registration_holds_seat(r)))
    end as spots_remaining,
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
  'Public aggregate counts for the parent-facing "spots available" UI and the admin schedule. THREE DIFFERENT NUMBERS, on purpose: enrolled = children actually in the class (payment_status=paid OR status=confirmed, matching ProgramRoster / ProgramsCalendar / email-program-roster); seats_taken = chairs that cannot be sold, via registration_holds_seat(), which also counts a live checkout, an ACH transfer clearing, and a waitlisted family holding an unexpired invite; spots_remaining = max_capacity - seats_taken, derived from the ENFORCED number so a seat mid-checkout is never advertised. spots_remaining is NULL - never 0 - when max_capacity is NULL or <= 0, because such a class is uncapped and can never be full; a reader must show it as open with no count rather than printing the NULL as a number (see 20260819u: greatest() ignores NULLs and turned "no limit" into "no room"). enrolled and seats_taken are MEANT to differ - see 20260819j before making them agree. security_invoker = on, so RLS applies to the caller and anon sees zeros by design (2026-06-06 hotfix). Returns NO PII.';
