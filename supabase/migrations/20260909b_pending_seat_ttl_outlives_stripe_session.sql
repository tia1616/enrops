-- The seat hold must OUTLIVE the Stripe session, not match it. 30 -> 40 minutes.
--
-- THE BUG IN 20260909a, caught in review before it left staging.
-- That migration set the hold to 30 minutes and create-checkout set the Stripe
-- session's expires_at to 30 minutes, on the reasoning that the two must agree.
-- They must not AGREE - the hold must be the LONGER of the two, because they are
-- started from different clocks and confirmed by a third:
--
--   T+0.0s   create-registration inserts the row; registered_at defaults to now()
--   T+2.0s   create-checkout creates the session; expires_at = now() + 30 min
--   ...
--   T+30:00  the HOLD lapses (registered_at + 30 min)
--   T+30:02  STRIPE finally stops accepting payment on that session
--
-- So for two seconds - and for however much longer the confirming webhook takes
-- to arrive, which is the part that actually matters - a family can still pay for
-- a chair we have already put back on sale. Last seat in the class, parent A pays
-- at T+29:50, parent B's create-registration sees it free and takes it, then A's
-- checkout.session.completed lands. Fifteen children in a fourteen-seat room and
-- a card charged for a seat that does not exist: exactly the failure the 30
-- minutes was chosen to prevent, reintroduced by making the numbers equal.
--
-- 40 MINUTES = STRIPE'S 30-MINUTE FLOOR + 10 MINUTES OF SLACK.
-- The session still dies at 30 minutes, so a family cannot pay after that; the
-- extra ten exist only to cover the ordering skew above and a late webhook.
-- The seat is therefore never sellable while payment is still possible, and a
-- genuinely abandoned checkout still frees its chair inside the hour instead of
-- holding it for a day.
--
-- INVARIANT, for whoever changes this next: DB TTL > create-checkout's
-- CHECKOUT_WINDOW_MINUTES. Lower the TTL to the session length or below and the
-- oversell window comes straight back.
--
-- Body is byte-identical to 20260909a. Only the default interval moves.
-- Grants are preserved by CREATE OR REPLACE and anon must keep EXECUTE, which
-- program_enrollment needs under security_invoker to answer an anonymous visitor.

create or replace function public.registration_holds_seat(
  r registrations,
  p_pending_ttl interval default interval '40 minutes'
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
  'Does this registration occupy a chair? confirmed always; pending only while its checkout could still be paid - 40 minutes, which DELIBERATELY EXCEEDS create-checkout''s CHECKOUT_WINDOW_MINUTES (30, Stripe''s floor) so the session dies before the hold does and a late webhook cannot land on a seat already resold. Never lower this to the session length or below. ACH ''processing'' holds for the whole settlement window; a waitlist row only while an unexpired, unclaimed invite names it.';
