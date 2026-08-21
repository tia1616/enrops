-- 20260821d_cancel_superseded_pending.sql
--
-- ONE CHILD, ONE SEAT. A parent who abandons checkout and comes back leaves a second
-- pending registration behind, and BOTH hold a seat for 24 hours - so the class reads one
-- seat fuller than it is until the older one ages out.
--
-- FOUND BY JESSICA'S OWN STAGING WALK, 2026-08-21, in the exact sequence the waiting-list
-- fix is designed to make possible: click the invite, abandon Stripe, come back through
-- the same link, pay. Two pending rows for Priya, the paid one confirmed, the abandoned
-- one still holding a seat -> Saturday Ballet Intensive read 7 of 6.
--
--   20:57:35  create-registration  invite claimed, held by 0650f2ef   <- abandoned
--   20:59:12  create-registration  invite claimed, held by 93f12adb   <- paid
--   20:59:40  stripe-webhook       invite spent on payment, 1 row
--             ...and 0650f2ef kept its seat.
--
-- WHOSE BUG. The double-pending mechanism predates this work: any parent who abandons and
-- restarts from the ordinary registration page makes two rows, and the abandoned-chase
-- automation already misfires on exactly this residue. What the waiting-list fix changed
-- is that coming BACK through the link is now possible at all, so this route is no longer
-- theoretical - it is the route families are meant to use.
--
-- WHY THIS RUNS AFTER PAYMENT AND NOT AT CREATION. The tempting fix is for
-- create-registration to cancel the older row when it makes the newer one. That is the
-- riskier direction: at creation time NOBODY has paid, both checkout sessions are live,
-- and cancelling one means cancelling a session the family might still be completing.
-- After a successful payment there is no ambiguity left about which registration is real.
-- The cost of waiting is that the over-count exists for the length of one checkout, which
-- is correct anyway - during that window a seat genuinely is being held twice, and the
-- class is full either way.
--
-- READS-FULLER, NEVER EMPTIER. Worth stating because it decides the severity: an
-- uncancelled orphan makes the class look FULL, so it can never oversell. What it costs is
-- that a genuinely freed seat stays invisible - the sweep reads the class as full and does
-- not offer it - for up to 24 hours. Self-healing, no money at risk.

create or replace function public.cancel_superseded_pending_registrations(
  p_registration_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_cancelled integer := 0;
begin
  if p_registration_ids is null or cardinality(p_registration_ids) = 0 then
    return 0;
  end if;

  update registrations old
     set status       = 'cancelled',
         cancelled_at = now()
   where old.status = 'pending'
     and old.cancelled_at is null
     -- Never the rows we were just handed. They are the ones that got paid for.
     and not (old.id = any (p_registration_ids))

     -- NEVER TOUCH A ROW WITH MONEY ON IT. Three independent guards, because this is a
     -- cancellation on the money path and each one fails safe on its own:
     --   * payment_status 'paid' is the obvious one.
     --   * a payment intent means Stripe has a charge object pointing at this row, so
     --     money may have moved even if our own columns have not caught up.
     --   * ACH 'processing' is a bank transfer in flight. It holds its seat for as long
     --     as it takes, on purpose, and cancelling it would drop a paying family.
     and coalesce(old.payment_status, '') <> 'paid'
     and old.stripe_payment_intent_id is null
     and coalesce(old.ach_payment_state, '') <> 'processing'

     -- SUPERSEDED BY ONE OF THE ROWS JUST PAID FOR: same class, same child, same parent,
     -- same organisation.
     --
     -- Same PARENT is required deliberately, though the duplicate would be just as real
     -- without it. Two different parents holding checkouts for one child in one class is
     -- rare enough - separated households, a carer registering alongside - that a human
     -- should see it rather than have one silently cancelled by the other's payment. The
     -- cost of leaving that case alone is one stale seat for 24 hours, which is the same
     -- cost we already accept everywhere else.
     --
     -- Same ORGANISATION is belt-and-braces: program_id already implies it, but this
     -- function takes ids from a webhook payload and a tenant predicate on a cross-row
     -- cancellation is not something to leave implied.
     and exists (
       select 1
       from registrations paid
       where paid.id = any (p_registration_ids)
         and paid.id <> old.id
         and paid.program_id      = old.program_id
         and paid.student_id      = old.student_id
         and paid.parent_id       = old.parent_id
         and paid.organization_id = old.organization_id
     );

  get diagnostics v_cancelled = row_count;
  return v_cancelled;
end;
$function$;

comment on function public.cancel_superseded_pending_registrations(uuid[]) is
  'After a cart is paid, cancel any leftover PENDING registration for the same class, '
  'child and parent that was not part of it - the residue of an abandoned checkout the '
  'family then restarted. Both rows hold a seat under registration_holds_seat, so the '
  'class reads one seat fuller than it is until the orphan ages out. Never touches a row '
  'that is paid, carries a Stripe payment intent, or has an ACH transfer in flight. '
  'Called by stripe-webhook once the confirm write succeeds. Returns the number cancelled.';

-- GRANTS. SECURITY DEFINER and it cancels registrations, so service_role only.
-- `revoke from public` does NOT remove anon's EXECUTE - Supabase grants that directly -
-- so anon is revoked BY NAME. Read proacl back after applying.
revoke all on function public.cancel_superseded_pending_registrations(uuid[]) from public;
revoke all on function public.cancel_superseded_pending_registrations(uuid[]) from anon;
revoke all on function public.cancel_superseded_pending_registrations(uuid[]) from authenticated;
grant execute on function public.cancel_superseded_pending_registrations(uuid[]) to service_role;
