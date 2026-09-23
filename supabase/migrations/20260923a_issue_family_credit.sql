-- Credits, chunk 2: make issuing a credit atomic against its own ceiling.
--
-- WHY THIS EXISTS. The edge function computed
--   eligible = paid - refunded - credited
-- read from the database, spent one to three seconds talking to Stripe to get
-- the real charged total, and only then inserted the credit. Between that read
-- and that write there is nothing holding the ceiling still.
--
-- The double-CLICK is already covered: both requests carry the same
-- idempotency key and the second loses to uq_family_credits_org_idempotency.
-- What is NOT covered is two DIFFERENT keys - two browser tabs, or two admins -
-- because each drawer mount mints its own key. Both read eligible = 24000,
-- both pass the check, both insert, and a family that paid $240 is owed $480.
--
-- A refund cannot fail this way, and that asymmetry is the point: Stripe itself
-- refuses to over-refund a charge, so the refund path has a second opinion. The
-- credit path makes no Stripe call at all. `family_credits` has only
-- `amount_cents > 0` and the per-org idempotency index - nothing relates the
-- SUM of a registration's credits to what was actually paid. So the guard has
-- to be here, in the write, or it is not a guard.
--
-- THE LOCK IS THE ONE THIS REPO ALREADY USES. `pg_advisory_xact_lock(hashtext(
-- '<domain>:' || <id>))` inside a SECURITY DEFINER function is the waitlist's
-- pattern, in twelve places since 20260819d. Keyed on the REGISTRATION, because
-- that is the scope the ceiling is about: two different families being credited
-- at the same moment must not wait on each other.
--
-- WHAT THE CALLER STILL OWNS. `p_paid_minus_refunded_cents` is computed by the
-- edge function from the real Stripe charge, because the database cannot know
-- it - registrations.amount_cents is the BASE price and understates what was
-- charged whenever the family pays the enrops service fee. This function does
-- NOT trust it as a credit amount; it uses it only as the ceiling to subtract
-- already-issued credits from. The caller also refuses outright when that
-- Stripe read failed, so a guessed ceiling never reaches here.

create or replace function public.issue_family_credit(
  p_organization_id             uuid,
  p_parent_id                   uuid,
  p_registration_id             uuid,
  p_amount_cents                integer,
  p_reason                      text,
  p_note                        text,
  p_idempotency_key             text,
  p_paid_minus_refunded_cents   integer
)
returns table (
  credit_id       uuid,
  amount_cents    integer,
  already_existed boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id       uuid;
  v_amt      integer;
  v_status   text;
  v_credited integer;
begin
  -- One credit at a time per registration. Everything below - the idempotency
  -- answer, the ceiling, the insert - happens inside this lock, so a concurrent
  -- caller sees the finished state rather than the state before it started.
  perform pg_advisory_xact_lock(hashtext('family_credit:' || p_registration_id::text));

  -- IDEMPOTENCY IS ANSWERED FIRST, and the lookup deliberately does NOT filter
  -- on status, because uq_family_credits_org_idempotency does not either.
  -- Filtering it here made the two disagree: a voided credit looked absent to
  -- this query and still occupied the key in the index, so reusing that key
  -- fell through to the insert and died on a raw 23505 the caller could not
  -- interpret. One rule, one place - and the index is the rule.
  --
  -- A voided credit is still not a success, though. It was withdrawn as issued
  -- in error and is excluded from the ceiling below, so handing it back as
  -- `already_existed` would withdraw a family against a credit worth nothing.
  -- It gets its own error instead, and the caller uses a fresh key.
  --
  -- The match is scoped to this registration as well as the key: a key reused
  -- against a DIFFERENT registration must not answer with the first one's
  -- credit, which would report a credit that does not exist for that family.
  if p_idempotency_key is not null then
    select fc.id, fc.amount_cents, fc.status
      into v_id, v_amt, v_status
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

      -- Same key, different registration. The index would refuse the insert
      -- anyway; saying so plainly beats a 23505.
      if not exists (
        select 1 from public.family_credits fc2
        where fc2.id = v_id and fc2.source_registration_id = p_registration_id
      ) then
        raise exception 'issue_family_credit: idempotency key % on organisation % is already used by another registration',
          p_idempotency_key, p_organization_id
          using errcode = 'FC003';
      end if;

      credit_id := v_id; amount_cents := v_amt; already_existed := true;
      return next;
      return;
    end if;
  end if;

  -- THE CEILING, RE-READ UNDER THE LOCK. This is the line the whole function
  -- exists for: the caller's copy of this number was read before its Stripe
  -- round-trip and may be stale by the time it gets here.
  select coalesce(sum(fc.amount_cents), 0)
    into v_credited
  from public.family_credits fc
  where fc.source_registration_id = p_registration_id
    and fc.status <> 'void';

  if p_amount_cents > (p_paid_minus_refunded_cents - v_credited) then
    -- A PRIVATE ERROR CLASS, never P0xxx. Class P0 belongs to plpgsql - P0001
    -- is what every bare RAISE EXCEPTION emits and P0002 is no_data_found - so
    -- a caller matching on one of those would swallow unrelated failures as
    -- this one.
    raise exception 'issue_family_credit: % exceeds the % still available on registration %',
      p_amount_cents, (p_paid_minus_refunded_cents - v_credited), p_registration_id
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
  returning id, family_credits.amount_cents into v_id, v_amt;

  credit_id := v_id; amount_cents := v_amt; already_existed := false;
  return next;
end;
$$;

-- GRANTS, revoked BY NAME first. `revoke ... from public` does not remove a
-- privilege anon or authenticated hold in their own right, and production
-- carries an ALTER DEFAULT PRIVILEGES rule that grants EXECUTE on new functions
-- to those roles - which is how a definer function ended up reachable by anon
-- once before. Only the edge function's service role may issue a credit.
revoke all     on function public.issue_family_credit(uuid, uuid, uuid, integer, text, text, text, integer) from public;
revoke execute on function public.issue_family_credit(uuid, uuid, uuid, integer, text, text, text, integer) from anon;
revoke execute on function public.issue_family_credit(uuid, uuid, uuid, integer, text, text, text, integer) from authenticated;
grant  execute on function public.issue_family_credit(uuid, uuid, uuid, integer, text, text, text, integer) to service_role;

comment on function public.issue_family_credit(uuid, uuid, uuid, integer, text, text, text, integer) is
  'Issues one family credit atomically: advisory lock on the registration, idempotency answered first, ceiling re-read under the lock, then the insert. Raises FC001 when the amount exceeds what is still available. The caller supplies paid-minus-refunded because only it can read the real charged total from Stripe.';
