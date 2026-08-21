-- 20260821c_waitlist_consume_on_payment.sql
--
-- The second half of "abandoning Stripe must not cost the family their place".
-- 20260821b made the claim exist and stopped create-registration spending the invite.
-- This makes PAYMENT spend it, makes the two cancel paths survive a claim, and lets a
-- class with two free seats offer two families at once.
--
-- FOUR CHANGES, and the middle two are not optional polish - they are a latent break
-- that 20260821b shipped to BOTH databases and that only stayed quiet because nothing
-- sets a claim yet (create-registration is still branch-only).
--
--   1. waitlist_invite_consume_claim(uuid[])  NEW. Spend the invite on payment, found
--      BY CLAIM rather than by token, because by the time Stripe pays the token may be
--      gone.
--   2. waitlist_expire_invites()  must SKIP a claimed row.
--   3. waitlist_remove()          must CLEAR the claim it is cancelling over.
--   4. waitlist_offer_next()      must skip rows already offered or mid-checkout, so a
--      class with two free seats invites two different families.
--
-- WHY 2 AND 3 ARE BREAKS, not improvements. registrations_waitlist_claim_shape says a
-- claim may only sit on a row whose status is still 'waitlist'. Both of those functions
-- cancel a waitlist row WITHOUT nulling the claim, so both raise 23514 check_violation
-- the moment they meet a family who is mid-checkout. Proved on staging before writing
-- this, by running each function's exact UPDATE against a deliberately claimed fixture
-- row inside a rolled-back probe:
--
--   expire: 23514 / new row for relation "registrations" violates check constraint
--           "registrations_waitlist_claim_shape"
--   remove: 23514 / ... same ...
--
-- The expire case is the serious one: waitlist_expire_invites cancels every lapsed row
-- on the PLATFORM in a single UPDATE, so one claimed lapsed row would fail the whole
-- statement and stop expiry for every org, every tick, until someone noticed.

-- 1. CONSUME ON PAYMENT, BY CLAIM ------------------------------------------------
--
-- WHY NOT BY TOKEN. stripe-webhook cannot consume by token and never could: it is
-- handed registration ids in the Checkout session metadata, not the invite token, and
-- by the time payment lands the window may have lapsed and taken the token with it.
-- The claim is the durable link between "this family paid" and "this waitlist row is
-- theirs", so the claim is what we look up.
--
-- AN ARRAY, NOT ONE ID, because the webhook confirms a whole cart in one
-- .in('id', regIds) update and a cart can hold two invited children in two different
-- classes. Consuming per-id would need N round trips and could half-succeed.
--
-- NO UNEXPIRED REQUIREMENT, deliberately. A family who PAID keeps the place whatever
-- the clock says; the window governs how long we hold a seat for someone who has not
-- paid, and it has no business voiding a completed payment.
--
-- Returns the number of waitlist rows spent, so the webhook can log a real number.
create or replace function public.waitlist_invite_consume_claim(
  p_registration_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_lock_progs uuid[];
  v_hit_progs  uuid[];
  v_prog       uuid;
  v_consumed   integer := 0;
begin
  if p_registration_ids is null or cardinality(p_registration_ids) = 0 then
    return 0;
  end if;

  -- WHICH PROGRAMS TO LOCK, derived from the CART's own rows rather than from the
  -- claims pointing at them. Those rows already exist and their program_id cannot
  -- change, so this set is fixed and race-free - whereas probing "which waitlist rows
  -- currently claim these ids" could miss a claim landing between the probe and the
  -- lock. Sorted, and the same key and sort order as waitlist_expire_invites, so two
  -- carts confirming at once queue instead of deadlocking.
  select coalesce(array_agg(distinct r.program_id order by r.program_id), '{}')
    into v_lock_progs
  from registrations r
  where r.id = any (p_registration_ids);

  if cardinality(v_lock_progs) = 0 then
    return 0;
  end if;

  foreach v_prog in array v_lock_progs loop
    perform pg_advisory_xact_lock(hashtext('waitlist:' || v_prog::text));
  end loop;

  -- Spend the invite. Same column set as waitlist_invite_consume, including nulling
  -- the claim: a cancelled row may not carry one (registrations_waitlist_claim_shape).
  with spent as (
    update registrations
       set status                           = 'cancelled',
           cancelled_at                     = now(),
           waitlist_invite_token            = null,
           waitlist_invited_at              = null,
           waitlist_invite_expires_at       = null,
           waitlist_position                = null,
           waitlist_claimed_registration_id = null
     where status = 'waitlist'
       and cancelled_at is null
       and waitlist_claimed_registration_id = any (p_registration_ids)
    returning program_id
  )
  select coalesce(array_agg(distinct program_id order by program_id), '{}'), count(*)
    into v_hit_progs, v_consumed
  from spent;

  if v_consumed = 0 then
    return 0;
  end if;

  -- Renumber from what actually changed, not from what we guessed. In the normal case
  -- v_hit_progs is a subset of the locks already held above (create-registration only
  -- ever claims a row in the invite's own program). A cross-program claim would be a
  -- caller bug rather than something to renumber wrongly, so the lock is re-taken -
  -- advisory locks are re-entrant, so for the normal subset this acquires nothing.
  foreach v_prog in array v_hit_progs loop
    perform pg_advisory_xact_lock(hashtext('waitlist:' || v_prog::text));

    -- Close the gap. THE SAME EXPRESSION as waitlist_remove, waitlist_invite_consume
    -- and waitlist_expire_invites, copied not rewritten: leaving by paying and leaving
    -- by asking to come off must not renumber a queue differently.
    with ordered as (
      select r.id, row_number() over (order by r.waitlist_position, r.registered_at) as pos
      from registrations r
      where r.program_id = v_prog
        and r.status = 'waitlist'
        and r.cancelled_at is null
    )
    update registrations r
       set waitlist_position = o.pos
      from ordered o
     where r.id = o.id
       and r.waitlist_position is distinct from o.pos;
  end loop;

  return v_consumed;
end;
$function$;

comment on function public.waitlist_invite_consume_claim(uuid[]) is
  'Spend the waiting-list invites belonging to a cart that has just been PAID, found by '
  'waitlist_claimed_registration_id rather than by token (the token may already have '
  'lapsed - a family who paid keeps the place regardless of the clock). Cancels each '
  'claimed waitlist row and renumbers every affected queue with the same expression as '
  'waitlist_remove. Called by stripe-webhook once the confirm write succeeds. Returns '
  'the number of rows spent.';

-- 2. EXPIRY MUST NOT TOUCH A FAMILY WHO IS MID-CHECKOUT --------------------------
--
-- Reproduced verbatim from the live definition except for the two claim terms.
--
-- A claim means "this family clicked in time and a real pending registration is holding
-- the seat for them right now". Cancelling that row would (a) violate
-- registrations_waitlist_claim_shape and fail the whole platform-wide UPDATE, and
-- (b) if it somehow succeeded, email a family mid-payment to say their place has gone.
--
-- This does NOT keep a claimed row alive forever. waitlist_release_stale_claims runs
-- FIRST on every tick and clears any claim whose pending registration has stopped
-- holding a seat, so a claim that survives into this step is a live checkout. Once the
-- checkout dies the claim is released and the row lapses normally on the next tick -
-- which is the agreed rule: abandoning Stripe costs the checkout, the WINDOW running
-- out still costs the place.
create or replace function public.waitlist_expire_invites()
returns table(registration_id uuid, program_id uuid, organization_id uuid, parent_email text, child_first_name text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_progs uuid[]; v_prog uuid;
begin
  select coalesce(array_agg(distinct r.program_id order by r.program_id), '{}') into v_progs
  from registrations r
  where r.status = 'waitlist' and r.cancelled_at is null
    and r.waitlist_invite_expires_at is not null and r.waitlist_invite_expires_at <= now()
    and r.waitlist_claimed_registration_id is null;
  if cardinality(v_progs) = 0 then return; end if;
  foreach v_prog in array v_progs loop perform pg_advisory_xact_lock(hashtext('waitlist:' || v_prog::text)); end loop;
  drop table if exists _done;
  create temp table _done (id uuid, program_id uuid, organization_id uuid, parent_id uuid, student_id uuid) on commit drop;
  with upd as (
    update registrations r set status = 'cancelled', cancelled_at = now(),
        waitlist_invited_at = null, waitlist_invite_expires_at = null, waitlist_invite_token = null, waitlist_position = null
     where r.status = 'waitlist' and r.cancelled_at is null and r.waitlist_invite_expires_at is not null
       and r.waitlist_invite_expires_at <= now() and r.program_id = any (v_progs)
       and r.waitlist_claimed_registration_id is null
    returning r.id, r.program_id, r.organization_id, r.parent_id, r.student_id
  ) insert into _done select * from upd;
  if not exists (select 1 from _done) then return; end if;
  for v_prog in select distinct d.program_id from _done d order by 1 loop
    with ordered as (
      select r.id, row_number() over (order by r.waitlist_position, r.registered_at) as pos
      from registrations r where r.program_id = v_prog and r.status = 'waitlist' and r.cancelled_at is null
    ) update registrations r set waitlist_position = o.pos from ordered o
     where r.id = o.id and r.waitlist_position is distinct from o.pos;
  end loop;
  return query
    select d.id, d.program_id, d.organization_id, pa.email, s.first_name
    from _done d left join parents pa on pa.id = d.parent_id left join students s on s.id = d.student_id;
end;
$function$;

-- 3. AN OPERATOR REMOVING SOMEONE MID-CHECKOUT -----------------------------------
--
-- Reproduced verbatim from the live definition except for nulling the claim.
--
-- "Take this family off the list" means off the list, checkout in flight or not - an
-- operator asking for that has context we do not. What must not happen is the raw 23514
-- they got before: a constraint violation surfacing in the admin UI as a failed action
-- with no explanation. Their pending registration is untouched and still holds its own
-- seat; it ages out or is paid for on its own terms.
create or replace function public.waitlist_remove(p_registration_id uuid, p_org_id uuid)
returns table(removed boolean, remaining integer)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_program uuid;
  v_n       integer;
begin
  select r.program_id into v_program
  from registrations r
  where r.id = p_registration_id
    and r.organization_id = p_org_id
    and r.status = 'waitlist'
    and r.cancelled_at is null;

  if v_program is null then
    return query select false, 0;
    return;
  end if;

  if not can_edit_org(p_org_id) then
    raise exception 'waitlist_remove: not permitted for organisation %', p_org_id
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('waitlist:' || v_program::text));

  update registrations
     set status       = 'cancelled',
         cancelled_at = now(),
         waitlist_invited_at        = null,
         waitlist_invite_expires_at = null,
         waitlist_invite_token      = null,
         waitlist_position          = null,
         -- A cancelled row may not carry a claim (registrations_waitlist_claim_shape).
         waitlist_claimed_registration_id = null
   where id = p_registration_id;

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

  select count(*) into v_n
  from registrations r
  where r.program_id = v_program
    and r.status = 'waitlist'
    and r.cancelled_at is null;

  return query select true, v_n;
end;
$function$;

-- 4. TWO SEATS, TWO FAMILIES -----------------------------------------------------
--
-- WHY LOOPING THE SWEEP WAS NOT ENOUGH. This function always took the TOP row of the
-- queue, and when that row already held a live offer it returned already_invited=true
-- and stopped. Called twice you got the same family twice; the second seat was never
-- offered to anybody.
--
-- SO SELECTION CHANGES, from "the top row" to "the top row that is free to be offered":
-- no live offer, no lapsed offer awaiting expiry, and no checkout in flight. Which
-- reduces to waitlist_invite_expires_at is null AND the claim is null.
--
--   * A LAPSED row is excluded rather than re-offered, and that is the guard WL002 used
--     to provide. Jessica's rule from 2026-08-19 is that a hold running out costs the
--     family their place, so a lapsed row is on its way to cancelled and must never be
--     handed a fresh window - which would silently give one family unlimited turns and
--     never send them the "your hold ran out" note. Making it structural in the SELECT
--     is stronger than an exception that only fired when the lapsed row was on top.
--   * A CLAIMED row is excluded because that family is mid-payment. Their pending
--     registration holds the seat, program_seat_counts already counts it, and offering
--     the same seat again would oversell it.
--
-- already_invited IS GONE from the return, not left returning false forever. Selection
-- now skips offered rows, so nothing can set it; a column that is structurally always
-- false, which its one caller has to remember to ignore, is worse than no column. The
-- drop and the recreate are in this one transaction, so no cron tick sees it missing.
-- Sole caller is lifecycle-automations-cron/waitlistSweep.ts, changed in the same pass.
-- No anon or authenticated EXECUTE has ever existed, so no client can be calling it.
--
-- WL002 SURVIVES, demoted from a guard to a diagnostic, and is now raised only when
-- there is nobody offerable AND the reason is a lapsed row expiry has not cleared. It
-- no longer stops a healthy program: with expiry broken, the families behind a lapsed
-- row still get their offers, which is what waitlistSweep.ts:107 wants when it carries
-- on past an expire failure. A climbing count still means expiry is failing.
--
-- WL001 STAYS AFTER SELECTION. A family holding an offer or a claim is already sitting
-- in a seat and program_seat_counts counts both, so the free-seat question is only
-- meaningful once we know who we would be offering to.
drop function if exists public.waitlist_offer_next(uuid, uuid, interval);

create function public.waitlist_offer_next(
  p_program_id uuid,
  p_org_id     uuid,
  p_hold       interval default '24:00:00'::interval
)
returns table(
  registration_id   uuid,
  invite_token      text,
  expires_at        timestamptz,
  parent_email      text,
  parent_first_name text,
  child_first_name  text,
  waitlist_position integer
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_cap integer; v_taken bigint; v_row record; v_token text; v_expires timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('waitlist:' || p_program_id::text));

  select sc.max_capacity, sc.seats_taken into v_cap, v_taken
  from program_seat_counts(array[p_program_id]) sc join programs p on p.id = sc.program_id
  where p.organization_id = p_org_id and p.status = 'open' and coalesce(p.runs_own_registration, false) = false;
  if not found then
    raise exception 'waitlist_offer_next: program % is not this organisation''s, not open, or not ours to sell', p_program_id using errcode = '42501';
  end if;

  select r.id, r.waitlist_position, r.waitlist_invited_at, r.waitlist_invite_expires_at, r.waitlist_invite_token,
         pa.email as parent_email, pa.first_name as parent_first, s.first_name as child_first
    into v_row
  from registrations r join parents pa on pa.id = r.parent_id join students s on s.id = r.student_id
  where r.program_id = p_program_id and r.status = 'waitlist' and r.cancelled_at is null
    and r.waitlist_invite_expires_at is null
    and r.waitlist_claimed_registration_id is null
  order by r.waitlist_position, r.registered_at limit 1;

  if v_row.id is null then
    if exists (
      select 1 from registrations r
      where r.program_id = p_program_id and r.status = 'waitlist' and r.cancelled_at is null
        and r.waitlist_invited_at is not null
        and r.waitlist_invite_expires_at is not null
        and r.waitlist_invite_expires_at <= now()
        and r.waitlist_claimed_registration_id is null
    ) then
      raise exception 'waitlist_offer_next: program % has nobody offerable and holds a lapsed invite that expiry has not cleared yet', p_program_id using errcode = 'WL002';
    end if;
    return;
  end if;

  if v_cap is not null and v_cap > 0 and v_taken >= v_cap then
    raise exception 'waitlist_offer_next: program % has no free seat to offer (% of %)', p_program_id, v_taken, v_cap using errcode = 'WL001';
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_expires := now() + p_hold;
  update registrations set waitlist_invited_at = now(), waitlist_invite_expires_at = v_expires, waitlist_invite_token = v_token where id = v_row.id;
  return query select v_row.id, v_token, v_expires, v_row.parent_email, v_row.parent_first, v_row.child_first, v_row.waitlist_position;
end;
$function$;

comment on function public.waitlist_offer_next(uuid, uuid, interval) is
  'Offer the free seat to the top family who is FREE TO BE OFFERED - not simply the top '
  'of the queue. Skips anyone already holding a live invite, anyone whose invite lapsed '
  'and is awaiting expiry, and anyone mid-checkout (waitlist_claimed_registration_id), '
  'so a class that frees two seats invites two different families on the same tick. '
  'Raises WL001 when there is no free seat, WL002 (diagnostic only) when nobody is '
  'offerable and a lapsed invite is still waiting on expiry. Returns no rows when the '
  'queue holds nobody offerable. Callable by service_role only.';

-- 5. GRANTS ----------------------------------------------------------------------
--
-- Both of these are SECURITY DEFINER and move seat accounting, and both are called
-- only from edge functions holding the service key. `revoke from public` does NOT
-- remove anon's EXECUTE - Supabase grants that directly - so anon is revoked BY NAME.
-- waitlist_offer_next was dropped and recreated above, so its grants are re-applied
-- from scratch here, not inherited. Read proacl back after applying.
revoke all on function public.waitlist_invite_consume_claim(uuid[]) from public;
revoke all on function public.waitlist_invite_consume_claim(uuid[]) from anon;
revoke all on function public.waitlist_invite_consume_claim(uuid[]) from authenticated;
grant execute on function public.waitlist_invite_consume_claim(uuid[]) to service_role;

revoke all on function public.waitlist_offer_next(uuid, uuid, interval) from public;
revoke all on function public.waitlist_offer_next(uuid, uuid, interval) from anon;
revoke all on function public.waitlist_offer_next(uuid, uuid, interval) from authenticated;
grant execute on function public.waitlist_offer_next(uuid, uuid, interval) to service_role;
