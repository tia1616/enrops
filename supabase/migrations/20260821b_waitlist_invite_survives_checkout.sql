-- 20260821b_waitlist_invite_survives_checkout.sql
--
-- ABANDONING STRIPE MUST NOT COST A FAMILY THEIR PLACE. Jessica's call, and it
-- matches every checkout platform checked: the WINDOW expires, not the place.
--
-- TODAY (prod, verified live before writing this): create-registration calls
-- waitlist_invite_consume after writing the registration rows but BEFORE payment.
-- Consume sets status='cancelled', clears the token, nulls waitlist_position and
-- renumbers the queue. So the moment a family clicks their invite they are OFF the
-- list - and if they then close the Stripe tab, their pending registration ages out
-- after 24h and they have no place, no position and a dead link.
--
-- WHY A COLUMN AND NOT A CROSS-ROW CHECK. The obvious fix is "consume on payment
-- instead of on creation", and that alone would keep their place - but between
-- clicking the invite and paying, the family would hold TWO seats: their live
-- invite holds one (see registration_holds_seat below) and their new pending row
-- holds another. registration_holds_seat is a STABLE per-row SQL function over a
-- `registrations` row; it cannot see that a sibling pending row is already holding
-- the seat, and it is called per row by program_seat_counts. So the fact "this
-- waitlist row's seat is currently being held by a real registration instead" has
-- to live ON the row. Hence one nullable column.
--
-- With one free seat the double-hold is harmless (the class correctly reads full
-- while the invited family checks out). It stops being harmless as soon as two
-- seats can be offered at once, which is the very next item in this build, so it is
-- fixed here rather than left as a known over-count.
--
-- THIS MIGRATION IS INERT ON ITS OWN, deliberately, because it is the fail-safe
-- half. The column is NULL for every existing row, so the new
-- `waitlist_claimed_registration_id is null` term in registration_holds_seat is
-- always true and every seat count is byte-identical. waitlist_invite_claim and
-- waitlist_release_stale_claims are added but nothing calls them yet. The edge
-- functions (create-registration, stripe-webhook, the sweep) ship AFTER this.
-- Shipping them first would be the unsafe order: create-registration would claim
-- against a function that does not exist, the RPC error is only logged, the invite
-- would never be spent, and the family would hold a live invite AND a pending
-- registration - an oversell.

-- 1. THE CLAIM ------------------------------------------------------------------

alter table registrations
  add column if not exists waitlist_claimed_registration_id uuid
    references registrations(id) on delete set null;

comment on column registrations.waitlist_claimed_registration_id is
  'Set on a WAITLIST row when the invited family has started checkout: it points at '
  'the pending registration created from their invite. While set, this row stops '
  'holding a seat (the pending row holds it instead) but keeps its token, its '
  'waitlist_invited_at and its waitlist_position - so abandoning Stripe costs the '
  'family the checkout, never their place. Cleared by waitlist_release_stale_claims '
  'when the pending row stops holding a seat, and made moot by '
  'waitlist_invite_consume, which cancels the row once payment succeeds. NULL on '
  'every non-waitlist row and on any waitlist row with no checkout in flight.';

-- Only meaningful on a waitlist row, and only ever pointing at a DIFFERENT row.
-- A self-reference would make a row hold no seat while nothing else held one.
alter table registrations
  drop constraint if exists registrations_waitlist_claim_shape;
alter table registrations
  add constraint registrations_waitlist_claim_shape check (
    waitlist_claimed_registration_id is null
    or (status = 'waitlist' and waitlist_claimed_registration_id <> id)
  );

-- Finding a claim from the pending side (the sweep's release step) must not scan.
create index if not exists idx_registrations_waitlist_claim
  on registrations (waitlist_claimed_registration_id)
  where waitlist_claimed_registration_id is not null;

-- 2. SEAT ACCOUNTING ------------------------------------------------------------
--
-- Unchanged except for the claim term. Everything else here is reproduced verbatim
-- from the live prod definition, comments included, because this is the function
-- every capacity decision in the product goes through and a silent edit to the
-- pending or ACH branch would mis-sell seats.

create or replace function public.registration_holds_seat(
  r registrations,
  p_pending_ttl interval default '24:00:00'::interval
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

-- 3. CLAIMING -------------------------------------------------------------------

create or replace function public.waitlist_invite_claim(
  p_token text,
  p_registration_id uuid
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_program uuid;
  v_hit     boolean := false;
begin
  -- The token must still be a LIVE offer on a live waitlist row. An expired or
  -- already-consumed token claims nothing, so a replayed link cannot park a claim
  -- on a row that has moved on.
  select r.program_id into v_program
  from registrations r
  where r.waitlist_invite_token = p_token
    and r.status = 'waitlist'
    and r.cancelled_at is null
    and r.waitlist_invite_expires_at is not null
    and r.waitlist_invite_expires_at > now();

  if v_program is null then
    return false;
  end if;

  -- Same key as join / remove / offer / consume, so a claim cannot interleave with a
  -- renumber or with the sweep offering this very row.
  perform pg_advisory_xact_lock(hashtext('waitlist:' || v_program::text));

  -- LAST CLAIM WINS, and that is correct rather than sloppy: a family who abandons
  -- Stripe and comes back through the same link gets a second pending registration,
  -- and it is the newer one that is holding their seat. Re-checked inside the lock,
  -- so a token that expired between the probe above and here claims nothing.
  update registrations
     set waitlist_claimed_registration_id = p_registration_id
   where waitlist_invite_token = p_token
     and status = 'waitlist'
     and cancelled_at is null
     and waitlist_invite_expires_at is not null
     and waitlist_invite_expires_at > now()
     and id <> p_registration_id;

  get diagnostics v_hit = row_count;
  return v_hit;
end;
$function$;

-- 4. RELEASING A CLAIM THAT NO LONGER MEANS ANYTHING ----------------------------
--
-- A claim says "a real registration is holding this seat for us". When that stops
-- being true - the family abandoned Stripe and their pending row aged out - the
-- claim must go, or the waitlist row sits there holding nothing while its invite is
-- still live, and the seat looks free to everyone including the offer function.
--
-- Cross-row by nature, so it cannot live in registration_holds_seat. The sweep
-- calls this BEFORE it expires invites and offers seats, so within a tick there is
-- no window where a seat reads free because of a stale claim.
--
-- Returns the number of claims released so the sweep can log a real number.
create or replace function public.waitlist_release_stale_claims(p_program_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_released integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('waitlist:' || p_program_id::text));

  -- NOT "is the claimed row cancelled" - the question is whether it still HOLDS A
  -- SEAT, which is the same predicate the capacity gate uses. A pending row that
  -- simply aged past the TTL is neither cancelled nor deleted, and that is the
  -- ordinary abandoned-checkout case this exists for. A missing row (claim dangling
  -- after a delete) also releases, via the left join.
  update registrations w
     set waitlist_claimed_registration_id = null
   where w.program_id = p_program_id
     and w.status = 'waitlist'
     and w.cancelled_at is null
     and w.waitlist_claimed_registration_id is not null
     and not exists (
       select 1
       from registrations c
       where c.id = w.waitlist_claimed_registration_id
         and registration_holds_seat(c)
     );

  get diagnostics v_released = row_count;
  return v_released;
end;
$function$;

-- 5. CONSUMING ------------------------------------------------------------------
--
-- Behaviour is unchanged - it still cancels the row and closes the gap - with two
-- differences. It clears the claim on the way out so no cancelled row is left
-- pointing at a registration, and it no longer requires the invite to be unexpired
-- (it never did): by the time payment succeeds the window may well have lapsed, and
-- a family who PAID keeps the place regardless of the clock. Reproduced from the
-- live prod definition so the renumber logic is identical.

create or replace function public.waitlist_invite_consume(p_token text)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_program uuid;
  v_hit     boolean := false;
begin
  select r.program_id into v_program
  from registrations r
  where r.waitlist_invite_token = p_token
    and r.status = 'waitlist'
    and r.cancelled_at is null;

  if v_program is null then
    return false;
  end if;

  -- Same key as join / remove / offer, so the renumber below cannot interleave with them.
  perform pg_advisory_xact_lock(hashtext('waitlist:' || v_program::text));

  update registrations
     set status                           = 'cancelled',
         cancelled_at                     = now(),
         waitlist_invite_token            = null,
         waitlist_invited_at              = null,
         waitlist_invite_expires_at       = null,
         waitlist_position                = null,
         waitlist_claimed_registration_id = null
   where waitlist_invite_token = p_token
     and status = 'waitlist'
     and cancelled_at is null;

  get diagnostics v_hit = row_count;
  if not v_hit then
    return false;
  end if;

  -- Close the gap, exactly as waitlist_remove does. Someone leaving by accepting a place
  -- and someone leaving by asking to come off must not renumber differently.
  with ordered as (
    select r.id, row_number() over (order by r.waitlist_position, r.registered_at) as pos
    from registrations r
    where r.program_id = v_program
      and r.status = 'waitlist'
      and r.cancelled_at is null
  )
  update registrations r
     set waitlist_position = o.pos
    from ordered o
   where r.id = o.id
     and r.waitlist_position is distinct from o.pos;

  return true;
end;
$function$;

-- 6. GRANTS ---------------------------------------------------------------------
--
-- SERVICE ROLE ONLY. Both new functions are SECURITY DEFINER and move seat
-- accounting, and both are called only from edge functions holding the service key.
-- `revoke from public` does NOT remove anon's EXECUTE - Supabase grants that
-- directly - so anon is revoked by name. Read proacl back after applying.
revoke all on function public.waitlist_invite_claim(text, uuid) from public;
revoke all on function public.waitlist_invite_claim(text, uuid) from anon;
revoke all on function public.waitlist_invite_claim(text, uuid) from authenticated;
grant execute on function public.waitlist_invite_claim(text, uuid) to service_role;

revoke all on function public.waitlist_release_stale_claims(uuid) from public;
revoke all on function public.waitlist_release_stale_claims(uuid) from anon;
revoke all on function public.waitlist_release_stale_claims(uuid) from authenticated;
grant execute on function public.waitlist_release_stale_claims(uuid) to service_role;
