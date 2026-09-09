-- An abandoned checkout stops holding a seat after 30 MINUTES, not 24 hours.
--
-- WHY THIS CHANGED
-- Jessica chose 24h on 2026-08-19, deliberately, to match the window the
-- abandoned-registration automation uses. That alignment was reasonable and it
-- cost a real enrolment three weeks later.
--
-- On 2026-09-08 an Irvington parent reached Stripe at 18:12 and did not pay. At
-- 18:55 she came back, and the class - cap 14, TWELVE children actually paid -
-- read 14 of 14 and offered her a waitlist. The two chairs standing between her
-- and a place were both dead checkouts, and one of them was HER OWN, 43 minutes
-- old. The operator screen said 12/14 the whole time. Jessica, reading it:
-- "abandoned shouldn't hold places... it prevents real people from paying and
-- signing up for a whole day."
--
-- WHY A HOLD EXISTS AT ALL, AND WHY THIS IS NOT ZERO
-- The registration row is written BEFORE payment, so the seat must be reserved
-- while the family is actually at the card form - otherwise two parents buy the
-- last chair and one of them has to be un-enrolled after being charged. The
-- question was never "hold or no hold", it was "how long", and 24 hours was far
-- past how long anyone types a card number.
--
-- THIRTY MINUTES IS A STRIPE FLOOR, NOT A PREFERENCE.
-- The hold may not be shorter than the Checkout Session it mirrors. While that
-- session is alive the family can still complete payment, so if the seat frees
-- first we sell it twice: parent A walks away, parent B buys the chair, parent A
-- returns to a still-open tab and pays. Fifteen children in a fourteen-seat room
-- and a charge for a seat that does not exist - worse than the bug being fixed.
-- create-checkout therefore now sets expires_at on BOTH sessions it creates
-- (CHECKOUT_WINDOW_MINUTES), and Stripe rejects an expires_at less than 30
-- minutes out. The two numbers are one number; changing either alone reopens the
-- oversell.
--
-- WHAT IS DELIBERATELY *NOT* CHANGED
--   * The abandoned-registration email stays at 24h (hours_after_pending). "This
--     seat is sellable again" and "this family has given up, write to them" are
--     different questions; mailing someone 30 minutes after they stepped away is
--     nagging. The migration that set 24h argued these should agree - on review
--     that conflated two questions, and they are now allowed to differ.
--   * ACH is untouched. 'processing' overrides the age test entirely, so a bank
--     transfer still holds its seat for the full 1-3 day settlement the Pay step
--     promises. expires_at governs submitting the checkout, not settling it.
--   * The BODY below is byte-identical to what is live. Only the default
--     interval moves. Copied from pg_get_functiondef on 2026-09-09 rather than
--     from the 20260819b migration file, which describes a four-argument
--     signature that no longer exists on either database.
--
-- GRANTS: CREATE OR REPLACE preserves them (this is not DROP + CREATE), and anon
-- must keep EXECUTE - program_enrollment is security_invoker=on, so an anonymous
-- visitor evaluates this function as itself when the catalog asks for spots
-- remaining. Verified before and after:
--   {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

create or replace function public.registration_holds_seat(
  r registrations,
  p_pending_ttl interval default interval '30 minutes'
)
returns boolean
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  select case
    -- Paid and enrolled.
    when r.status = 'confirmed' then true

    when r.status = 'pending' then
      case
        -- Bank transfer clearing. The Pay step promises 1-3 business days and the seat
        -- held meanwhile, so it is held for as long as it takes.
        when r.ach_payment_state = 'processing' then true
        -- Otherwise a checkout in flight: holds while alive, releases when dead. A NULL
        -- registered_at cannot be aged so it keeps the seat (fail safe: one unclearable
        -- row beats selling an occupied chair).
        else r.registered_at is null or r.registered_at > now() - p_pending_ttl
      end

    -- A WAITLISTED FAMILY WHO HAS BEEN OFFERED THE PLACE HOLDS IT until the offer lapses.
    -- This is the whole point of the migration: between "we emailed you the link" and
    -- "the link expired", the place is theirs and nobody else can buy it. An expired or
    -- never-sent offer holds nothing - a waitlist row is otherwise just an expression of
    -- interest.
    --
    -- UNLESS THEY HAVE ALREADY STARTED CHECKOUT. Then the pending registration named by
    -- waitlist_claimed_registration_id is holding the seat, and counting this row too
    -- would charge the class twice for one family. The token stays live so they can
    -- come back to the link; it just stops being what reserves the chair.
    when r.status = 'waitlist' then
      r.waitlist_claimed_registration_id is null
      and r.waitlist_invite_expires_at is not null
      and r.waitlist_invite_expires_at > now()

    -- cancelled / refunded hold nothing.
    else false
  end;
$function$;

comment on function public.registration_holds_seat(registrations, interval) is
  'Does this registration occupy a chair? confirmed always; pending only while its checkout is alive (30 minutes, matching create-checkout CHECKOUT_WINDOW_MINUTES and the Stripe session expires_at - change both together or the last seat can be sold twice); ACH ''processing'' for the whole settlement window; a waitlist row only while an unexpired, unclaimed invite names it. The 30 minutes lives HERE, once - thread p_pending_ttl if it ever needs to be per-org, never add a second literal.';
