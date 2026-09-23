-- Credits, code-review fixes: ONE ceiling, and the writers prove the org.
--
-- Five findings from the max-effort review, four of which collapse into two
-- root changes rather than four patches.
--
-- ---------------------------------------------------------------------------
-- A. THE CEILING IS ONE EXPRESSION, IN ONE FUNCTION, WITH ONE PREDICATE
-- ---------------------------------------------------------------------------
-- 20260923c wrote `paid - refunds - credits` four times: twice inline in the
-- writers, once in `registration_available_cents`, and once more in TypeScript.
-- The fourth copy had already drifted - it counted `status = 'succeeded'` while
-- the SQL counted `status <> 'failed'` - so the drawer offered money the server
-- was certain to refuse, then told the operator to reopen, which recomputed the
-- same wrong number. An unbreakable loop with a false explanation.
--
-- Both writers now CALL `registration_available_cents`, and so does the edge
-- function. One implementation, four callers.
--
-- ---------------------------------------------------------------------------
-- B. `<> 'failed'` WAS BOTH TOO LOOSE AND TOO TIGHT. RESERVED-OR-REAL REPLACES IT
-- ---------------------------------------------------------------------------
-- Too TIGHT: a reservation whose isolate died before Stripe was ever called sat
-- 'pending' forever with no id, permanently consuming the ceiling. Nothing
-- releases it - the webhook's only release matches on `stripe_refund_id`, which
-- such a row does not have, and the Refunds tab is read-only. That registration
-- could never be refunded or credited again without hand-editing the database.
--
-- Too LOOSE in the other direction: marking a row 'failed' RELEASED the ceiling,
-- and the edge function marked 'failed' on any Stripe error - including a
-- timeout, where Stripe may well have processed the refund. The money was then
-- available to give away a second time as a credit. That is a real double-spend,
-- and the credit path has no second opinion the way a re-refund does, because it
-- never contacts Stripe.
--
-- The predicate now asks the honest question - is this money reserved or gone? -
-- instead of the proxy question "is the row not failed":
--
--   succeeded                      -> counts. Money is out.
--   pending WITH a stripe id       -> counts, indefinitely. Stripe has it; it is
--                                     either settling or was healed by the
--                                     webhook after a timeout. Never release it.
--   pending, UNRESOLVED marked     -> counts, indefinitely. The refund call
--                                     threw without a definitive answer, so
--                                     Stripe may have taken the money.
--   pending, otherwise             -> counts for 30 minutes. That is a live
--                                     reservation whose request died before it
--                                     ever reached Stripe.
--   failed                         -> never counts.
--
-- THE `UNRESOLVED` CARVE-OUT IS THE IMPORTANT ONE, and a review caught its
-- absence. Without it the 30-minute window leaned entirely on the webhook
-- arriving inside 30 minutes - and the failure that creates an unresolved row
-- (trouble between us and Stripe) is exactly the failure that delays webhook
-- delivery. Correlated, so the release would fire precisely when it was most
-- likely to be wrong: at minute 31 the ceiling frees $240 Stripe already took,
-- and the credit path, which never contacts Stripe, hands it out again.
-- A reservation from a killed isolate carries no failure_reason at all, so the
-- two cases separate cleanly and the TTL still does the job it was added for.
--
-- This is the shape `20260909a_pending_seat_ttl_30_minutes.sql` already uses for
-- seats: expiry expressed in the READ, not as a sweeper that has to run.

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
       - coalesce((
           select sum(r.amount_cents) from public.refunds r
           where r.registration_id = p_registration_id
             and (
               r.status = 'succeeded'
               or (r.status = 'pending'
                   and (r.stripe_refund_id is not null
                        or coalesce(r.failure_reason, '') like 'UNRESOLVED %'
                        or r.created_at > now() - interval '30 minutes'))
             )
         ), 0)
       - coalesce((
           select sum(fc.amount_cents) from public.family_credits fc
           where fc.source_registration_id = p_registration_id
             and fc.status <> 'void'
         ), 0);
$$;

revoke all     on function public.registration_available_cents(uuid, integer) from public;
revoke execute on function public.registration_available_cents(uuid, integer) from anon;
revoke execute on function public.registration_available_cents(uuid, integer) from authenticated;
grant  execute on function public.registration_available_cents(uuid, integer) to service_role;

comment on function public.registration_available_cents(uuid, integer) is
  'THE ceiling for a registration: paid, less refunds that are reserved-or-real, less credits that are not void. The single implementation - reserve_refund_slot, issue_family_credit and refund-registration all read it. p_paid_cents comes from the caller because only it can read the real charged total from Stripe.';

-- ---------------------------------------------------------------------------
-- C. THE WRITERS PROVE THE ORGANISATION INSTEAD OF BELIEVING IT
-- ---------------------------------------------------------------------------
-- Both functions took `p_organization_id` (and `p_parent_id`) and wrote them
-- straight into the row. The `refunds` insert in particular moved OUT of the
-- edge function - where the value came from a registration row it had just read
-- and authorised the caller against - and INTO a definer function that trusted
-- a parameter.
--
-- 20260922b states the (organisation, parent) key is the entire defence for the
-- ten production parents with children at two organisations: a wrong org here
-- writes a credit spendable at the wrong business. The webhook already does this
-- exact check and says why - "guessing wrong refunds one operator's fee out of
-- another's balance". Not exploitable through today's single caller, which
-- derives both from the authorised row; but the function is the contract, and
-- proving a fact costs one SELECT while trusting it costs a tenant.

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
  v_avail   integer;
  v_reg_org uuid;
  v_id      uuid;
begin
  -- A NULL ceiling is not "no limit". Without this, `p_amount > (NULL - x - y)`
  -- is NULL, the IF takes its false branch and the INSERT proceeds with no
  -- check at all - fail-open, in the function whose only job is to be the guard.
  if p_paid_cents is null or p_paid_cents < 0 then
    raise exception 'reserve_refund_slot: p_paid_cents must be a non-negative amount, got %', p_paid_cents
      using errcode = 'FC005';
  end if;

  perform pg_advisory_xact_lock(hashtext('family_credit:' || p_registration_id::text));

  select r.organization_id into v_reg_org
  from public.registrations r where r.id = p_registration_id;

  if v_reg_org is null then
    raise exception 'reserve_refund_slot: registration % does not exist', p_registration_id
      using errcode = 'FC006';
  end if;
  if v_reg_org <> p_organization_id then
    raise exception 'reserve_refund_slot: registration % belongs to organisation %, not %',
      p_registration_id, v_reg_org, p_organization_id
      using errcode = 'FC006';
  end if;

  v_avail := public.registration_available_cents(p_registration_id, p_paid_cents);

  if p_amount_cents > v_avail then
    raise exception 'reserve_refund_slot: % exceeds the % still available on registration %',
      p_amount_cents, v_avail, p_registration_id
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

comment on function public.reserve_refund_slot(uuid, uuid, text, integer, text, uuid, boolean, integer) is
  'Reserves one refund slot: proves the registration belongs to the organisation, takes the shared registration lock, re-checks the ceiling via registration_available_cents, then writes the pending refunds row that the Stripe call is about to fulfil. FC004 over ceiling, FC005 bad p_paid_cents, FC006 organisation mismatch.';

create or replace function public.issue_family_credit(
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
  v_id        uuid;
  v_amt       integer;
  v_status    text;
  v_reason    text;
  v_avail     integer;
  v_reg_org   uuid;
  v_reg_parent uuid;
begin
  if p_paid_cents is null or p_paid_cents < 0 then
    raise exception 'issue_family_credit: p_paid_cents must be a non-negative amount, got %', p_paid_cents
      using errcode = 'FC005';
  end if;

  perform pg_advisory_xact_lock(hashtext('family_credit:' || p_registration_id::text));

  -- The idempotency lookup does NOT filter on status, because
  -- uq_family_credits_org_idempotency does not either. Filtering made the two
  -- disagree: a voided credit looked absent here and still occupied the key, so
  -- reusing it died on a raw 23505 the caller could not interpret.
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

      -- The STORED reason, not the caller's: on a retry the two can differ, and
      -- reason is the only record of which side ended the enrollment.
      credit_id := v_id; amount_cents := v_amt; already_existed := true; reason := v_reason;
      return next;
      return;
    end if;
  end if;

  select r.organization_id, r.parent_id into v_reg_org, v_reg_parent
  from public.registrations r where r.id = p_registration_id;

  if v_reg_org is null then
    raise exception 'issue_family_credit: registration % does not exist', p_registration_id
      using errcode = 'FC006';
  end if;
  if v_reg_org <> p_organization_id or v_reg_parent is distinct from p_parent_id then
    raise exception 'issue_family_credit: registration % belongs to organisation %/parent %, not %/%',
      p_registration_id, v_reg_org, v_reg_parent, p_organization_id, p_parent_id
      using errcode = 'FC006';
  end if;

  v_avail := public.registration_available_cents(p_registration_id, p_paid_cents);

  if p_amount_cents > v_avail then
    raise exception 'issue_family_credit: % exceeds the % still available on registration %',
      p_amount_cents, v_avail, p_registration_id
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

comment on function public.issue_family_credit(uuid, uuid, uuid, integer, text, text, text, integer) is
  'Issues one family credit atomically: proves the registration belongs to the organisation AND the parent, takes the shared registration lock, answers idempotency, re-checks the ceiling via registration_available_cents, then inserts. FC001 over ceiling, FC002 voided key, FC003 key used by another registration, FC005 bad p_paid_cents, FC006 organisation/parent mismatch. p_paid_cents is GROSS paid; refunds and credits are subtracted here, under the lock.';
