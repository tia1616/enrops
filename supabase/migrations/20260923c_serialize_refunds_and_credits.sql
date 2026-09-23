-- Credits, chunk 2 review fix: put REFUNDS and CREDITS on the same lock.
--
-- WHAT WAS STILL OPEN. 20260923a made issuing a credit atomic against other
-- CREDITS, and that closed the two-tabs-both-credit case. It did not close the
-- other axis. `issue_family_credit` was handed `p_paid_minus_refunded_cents` -
-- a number the edge function had computed BEFORE its one-to-three-second Stripe
-- round-trip - so a refund landing in that window was invisible to the ceiling,
-- and the refund path took no lock at all.
--
--   Registration paid $240. Admin A refunds $240; admin B credits $240 in the
--   same moment. B read refunds=0 before A's row existed, so B passed 24000 as
--   the ceiling, the lock found no prior CREDITS, and both wrote. The family
--   has the cash and an active $240 credit against the same dollars.
--
-- THE FIX IS ONE KEY FOR BOTH PATHS. Both functions below take
-- `pg_advisory_xact_lock(hashtext('family_credit:' || registration_id))` - the
-- same key `issue_family_credit` already used - and both re-derive the whole
-- ceiling under it:
--
--     available = paid - refunds(not failed) - credits(not void)
--
-- The caller still supplies `paid`, because only it can read the real charged
-- total from Stripe; registrations.amount_cents is the BASE price and
-- understates what was charged whenever the family pays the enrops service fee.
-- Everything that can be derived in the database now is.
--
-- WHY 'pending' REFUNDS COUNT. The refund path inserts its `refunds` row BEFORE
-- calling Stripe, precisely so there is an id to be idempotent against - which
-- makes that row a RESERVATION. Counting it means a refund in flight holds its
-- share of the ceiling and a concurrent credit cannot spend the same money.
-- 'failed' is excluded because that reservation was released; production
-- carries 23 succeeded and 1 failed and no long-lived pending rows, so this
-- changes nothing about existing data.
--
-- WHAT THIS DOES NOT CLOSE. A refund taken in the STRIPE DASHBOARD bypasses
-- both functions; nothing here can see it until the webhook writes the row.
-- That gap is named in refund-registration and belongs to the cash-out chunk.

-- ---------------------------------------------------------------------------
-- 1. RESERVE A REFUND SLOT, under the shared lock
-- ---------------------------------------------------------------------------
-- Replaces a bare INSERT in the refund loop. Same row, same columns; what is
-- added is the lock and the re-check, so the refund path can no longer commit
-- against a ceiling that moved while it was talking to Stripe.
create or replace function public.reserve_refund_slot(
  p_registration_id           uuid,
  p_organization_id           uuid,
  p_stripe_payment_intent_id  text,
  p_amount_cents              integer,
  p_reason                    text,
  p_refunded_by_user_id       uuid,
  p_cancelled_registration    boolean,
  p_paid_cents                integer
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_refunded integer;
  v_credited integer;
  v_id       uuid;
begin
  perform pg_advisory_xact_lock(hashtext('family_credit:' || p_registration_id::text));

  select coalesce(sum(r.amount_cents), 0) into v_refunded
  from public.refunds r
  where r.registration_id = p_registration_id
    and r.status <> 'failed';

  select coalesce(sum(fc.amount_cents), 0) into v_credited
  from public.family_credits fc
  where fc.source_registration_id = p_registration_id
    and fc.status <> 'void';

  if p_amount_cents > (p_paid_cents - v_refunded - v_credited) then
    raise exception 'reserve_refund_slot: % exceeds the % still available on registration %',
      p_amount_cents, (p_paid_cents - v_refunded - v_credited), p_registration_id
      using errcode = 'FC004';
  end if;

  insert into public.refunds (
    registration_id, organization_id, stripe_payment_intent_id, amount_cents,
    reason, refunded_by_user_id, cancelled_registration, status
  )
  values (
    p_registration_id, p_organization_id, p_stripe_payment_intent_id, p_amount_cents,
    p_reason, p_refunded_by_user_id, p_cancelled_registration, 'pending'
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all     on function public.reserve_refund_slot(uuid, uuid, text, integer, text, uuid, boolean, integer) from public;
revoke execute on function public.reserve_refund_slot(uuid, uuid, text, integer, text, uuid, boolean, integer) from anon;
revoke execute on function public.reserve_refund_slot(uuid, uuid, text, integer, text, uuid, boolean, integer) from authenticated;
grant  execute on function public.reserve_refund_slot(uuid, uuid, text, integer, text, uuid, boolean, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 2. ISSUE A CREDIT, now counting refunds under the same lock
-- ---------------------------------------------------------------------------
-- Signature change: `p_paid_minus_refunded_cents` becomes `p_paid_cents`. The
-- old name was the bug in miniature - it asked the caller to pre-subtract a
-- number that could go stale, when the database can read it fresh. Dropped
-- rather than replaced, because the parameter NAME is part of the call.
drop function if exists public.issue_family_credit(uuid, uuid, uuid, integer, text, text, text, integer);

create function public.issue_family_credit(
  p_organization_id  uuid,
  p_parent_id        uuid,
  p_registration_id  uuid,
  p_amount_cents     integer,
  p_reason           text,
  p_note             text,
  p_idempotency_key  text,
  p_paid_cents       integer
)
returns table (
  credit_id       uuid,
  amount_cents    integer,
  already_existed boolean,
  reason          text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id       uuid;
  v_amt      integer;
  v_status   text;
  v_reason   text;
  v_credited integer;
  v_refunded integer;
begin
  perform pg_advisory_xact_lock(hashtext('family_credit:' || p_registration_id::text));

  -- The lookup does NOT filter on status, because
  -- uq_family_credits_org_idempotency does not either. Filtering made the two
  -- disagree: a voided credit looked absent here and still occupied the key in
  -- the index, so reusing that key died on a raw 23505 the caller could not
  -- interpret. One rule, one place, and the index is the rule.
  if p_idempotency_key is not null then
    select fc.id, fc.amount_cents, fc.status, fc.reason
      into v_id, v_amt, v_status, v_reason
    from public.family_credits fc
    where fc.organization_id = p_organization_id
      and fc.idempotency_key = p_idempotency_key
    limit 1;

    if v_id is not null then
      if v_status = 'void' then
        raise exception 'issue_family_credit: idempotency key % on organisation % belongs to a voided credit; use a new key',
          p_idempotency_key, p_organization_id
          using errcode = 'FC002';
      end if;

      if not exists (
        select 1 from public.family_credits fc2
        where fc2.id = v_id and fc2.source_registration_id = p_registration_id
      ) then
        raise exception 'issue_family_credit: idempotency key % on organisation % is already used by another registration',
          p_idempotency_key, p_organization_id
          using errcode = 'FC003';
      end if;

      -- The STORED reason, not the caller's. On a retry the two can differ, and
      -- `reason` is the only record of which side ended the enrollment - so
      -- echoing the request back would let a caller believe the ledger says
      -- something it does not.
      credit_id := v_id; amount_cents := v_amt; already_existed := true; reason := v_reason;
      return next;
      return;
    end if;
  end if;

  -- BOTH SIDES OF THE CEILING, re-read under the lock. Refunds are counted here
  -- rather than pre-subtracted by the caller: the caller's copy was read before
  -- its Stripe round-trip and a refund reserved in that window would have been
  -- invisible.
  select coalesce(sum(r.amount_cents), 0) into v_refunded
  from public.refunds r
  where r.registration_id = p_registration_id
    and r.status <> 'failed';

  select coalesce(sum(fc.amount_cents), 0) into v_credited
  from public.family_credits fc
  where fc.source_registration_id = p_registration_id
    and fc.status <> 'void';

  if p_amount_cents > (p_paid_cents - v_refunded - v_credited) then
    raise exception 'issue_family_credit: % exceeds the % still available on registration %',
      p_amount_cents, (p_paid_cents - v_refunded - v_credited), p_registration_id
      using errcode = 'FC001';
  end if;

  insert into public.family_credits (
    organization_id, parent_id, amount_cents, status, reason,
    source_registration_id, note, idempotency_key
  )
  values (
    p_organization_id, p_parent_id, p_amount_cents, 'active', p_reason,
    p_registration_id, p_note, p_idempotency_key
  )
  returning id, family_credits.amount_cents, family_credits.reason
       into v_id, v_amt, v_reason;

  credit_id := v_id; amount_cents := v_amt; already_existed := false; reason := v_reason;
  return next;
end;
$$;

revoke all     on function public.issue_family_credit(uuid, uuid, uuid, integer, text, text, text, integer) from public;
revoke execute on function public.issue_family_credit(uuid, uuid, uuid, integer, text, text, text, integer) from anon;
revoke execute on function public.issue_family_credit(uuid, uuid, uuid, integer, text, text, text, integer) from authenticated;
grant  execute on function public.issue_family_credit(uuid, uuid, uuid, integer, text, text, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. READ THE CEILING, for an honest error
-- ---------------------------------------------------------------------------
-- When a write is refused because the ceiling moved, the caller must be able to
-- say what is ACTUALLY left. Reporting the number it read before the refusal
-- contradicts the refusal in the same response.
create or replace function public.registration_available_cents(
  p_registration_id uuid,
  p_paid_cents      integer
)
returns integer
language sql
stable security definer
set search_path = public, pg_temp
as $$
  select p_paid_cents
       - coalesce((select sum(r.amount_cents) from public.refunds r
                   where r.registration_id = p_registration_id and r.status <> 'failed'), 0)
       - coalesce((select sum(fc.amount_cents) from public.family_credits fc
                   where fc.source_registration_id = p_registration_id and fc.status <> 'void'), 0);
$$;

revoke all     on function public.registration_available_cents(uuid, integer) from public;
revoke execute on function public.registration_available_cents(uuid, integer) from anon;
revoke execute on function public.registration_available_cents(uuid, integer) from authenticated;
grant  execute on function public.registration_available_cents(uuid, integer) to service_role;
