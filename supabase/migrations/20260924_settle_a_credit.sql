-- DEPLOY ORDER: this migration, THEN refund-registration, THEN the frontend.
-- All three, and the middle one is not optional - see "THE FIFTH COPY" below.
-- As always the order is a property of what the change DEPENDS ON, not of the
-- file type; 20260923a is the sibling case that needs the opposite.
--
-- NAMED BY CONTENT, NOT BY LETTER: 20260924a/b are taken by other sessions.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS FOR
-- ---------------------------------------------------------------------------
-- A credit could be issued and nothing else: no way to undo one issued by
-- mistake, and no way to honour "actually I would rather have the money",
-- because a credit CONSUMES the refundable ceiling and so blocked the refund
-- that would pay it out. The only fix was editing the database by hand.
--
-- ---------------------------------------------------------------------------
-- THE DESIGN THIS FILE REPLACED, AND WHY IT WAS WRONG
-- ---------------------------------------------------------------------------
-- The first version let the operator mark a credit 'refunded' to release the
-- ceiling, then refund separately. A max-effort review killed it, correctly:
-- THE ACT THAT CREATED THE OBLIGATION DESTROYED THE ONLY REMINDER OF IT. The
-- instant the operator clicked, the credit left the operator's list, left
-- `credit_outstanding_cents`, and left the family's portal balance - before a
-- penny moved. One interruption and the family had lost their credit, received
-- nothing, and NO SURFACE IN THE PRODUCT showed the debt. The copy carried the
-- whole contract, and copy is not a guard.
--
-- 'refund_pending' is the fix: a state that STOPS CONSUMING THE CEILING (so the
-- refund can be made) while STILL COUNTING AS OWED everywhere a human looks.
-- Nothing is destroyed at the moment of intent. The liability is discharged by
-- `close_refund_pending_credit`, which only the refund path calls, and only
-- after Stripe has actually paid.
--
-- So there are now two different questions about a credit, and they have
-- different answers. Every reader below is deliberate about which it asks:
--   "does this still block a refund?"  -> ceiling: void/refunded/refund_pending
--                                         are all released
--   "does the business still owe it?"  -> liability: active AND refund_pending

-- ---------------------------------------------------------------------------
-- 1. THE NEW STATE, AND AN ACTOR ON THE LEDGER
-- ---------------------------------------------------------------------------
alter table public.family_credits
  drop constraint if exists family_credits_status_known;

alter table public.family_credits
  add constraint family_credits_status_known
  check (status in ('active', 'spent', 'refunded', 'refund_pending', 'void'));

comment on column public.family_credits.status is
  'active = some or all still available. spent = fully applied. refund_pending = the operator has committed to paying it back and the money has NOT gone yet; still owed, but no longer blocking the refund that will pay it. refunded = the money reached the family. void = issued in error and withdrawn.';

-- WHO DID IT. `refunds` records refunded_by_user_id and this path recorded
-- nobody, so "who ended this credit" was unanswerable from the database - on a
-- surface where one click zeroes a family's balance with no email sent.
alter table public.family_credit_movements
  add column if not exists actor_user_id uuid;

comment on column public.family_credit_movements.actor_user_id is
  'The signed-in operator who caused this movement. Null only for movements a machine made (a refund closing a refund_pending credit records the caller of the refund instead).';

-- ---------------------------------------------------------------------------
-- 2. THE CEILING: RELEASED BY ANY ENDING, INCLUDING A PENDING ONE
-- ---------------------------------------------------------------------------
-- A 'refunded' credit has a refunds row standing for the same money, so
-- counting both subtracts one payment twice: a family who paid $240, took a
-- $240 credit and cashed out would have shown a ceiling of MINUS $240 and been
-- unrefundable for the life of the record. 'refund_pending' is released for the
-- opposite reason - the refund has not happened YET and this is what lets it.
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
                        or (coalesce(r.failure_reason, '') like 'UNRESOLVED %'
                            and r.created_at > now() - interval '7 days')
                        or r.created_at > now() - interval '30 minutes'))
             )
         ), 0)
       - coalesce((
           select sum(fc.amount_cents) from public.family_credits fc
           where fc.source_registration_id = p_registration_id
             and fc.status not in ('void', 'refunded', 'refund_pending')
         ), 0);
$$;

revoke all     on function public.registration_available_cents(uuid, integer) from public;
revoke execute on function public.registration_available_cents(uuid, integer) from anon;
revoke execute on function public.registration_available_cents(uuid, integer) from authenticated;
grant  execute on function public.registration_available_cents(uuid, integer) to service_role;

comment on function public.registration_available_cents(uuid, integer) is
  'THE ceiling for a registration: paid, less refunds that are reserved-or-real, less credits that still block a refund. Void, refunded and refund_pending credits do not block. The single implementation - reserve_refund_slot, issue_family_credit and refund-registration all read it.';

create or replace function public.registration_payment_status_after_refund(
  p_registration_id uuid,
  p_paid_cents      integer
)
returns text
language sql
stable security definer
set search_path = public, pg_temp
as $$
  with r as (
    select coalesce(sum(amount_cents), 0) as refunded
    from public.refunds
    where registration_id = p_registration_id
      and status = 'succeeded'
  ),
  c as (
    select coalesce(sum(amount_cents), 0) as credited
    from public.family_credits
    where source_registration_id = p_registration_id
      and status not in ('void', 'refunded', 'refund_pending')
  )
  select case
           when r.refunded <= 0 then null
           when r.refunded >= greatest(p_paid_cents - c.credited, 0) then 'refunded'
           else 'partial'
         end
  from r, c;
$$;

revoke all     on function public.registration_payment_status_after_refund(uuid, integer) from public;
revoke execute on function public.registration_payment_status_after_refund(uuid, integer) from anon;
revoke execute on function public.registration_payment_status_after_refund(uuid, integer) from authenticated;
grant  execute on function public.registration_payment_status_after_refund(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. THE LIABILITY: refund_pending IS STILL OWED
-- ---------------------------------------------------------------------------
-- The whole point of the new state. The operator's total and the family's
-- portal balance must NOT drop when the operator merely commits to paying.
create or replace function public.get_revenue_summary(
  p_org  uuid,
  p_from timestamptz default null,
  p_to   timestamptz default null,
  p_term text default null
)
returns table(
  collected_cents          bigint,
  refunded_cents           bigint,
  expected_soon_cents      bigint,
  paid_count               bigint,
  external_count           bigint,
  has_enrops_payments      boolean,
  credit_outstanding_cents bigint
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
BEGIN
  IF NOT can_handle_money(p_org) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH term_prog AS (
    SELECT id FROM programs WHERE organization_id = p_org AND (p_term IS NULL OR term = p_term)
  ),
  pif AS (
    SELECT r.id, r.amount_cents, r.parent_id
    FROM registrations r
    WHERE r.organization_id = p_org
      AND r.payment_method = 'stripe'
      AND r.payment_status IN ('paid','partial','refunded')
      AND (p_from IS NULL OR r.registered_at >= p_from)
      AND (p_to   IS NULL OR r.registered_at <  p_to)
      AND (p_term IS NULL OR r.program_id IN (SELECT id FROM term_prog))
  ),
  inst_paid AS (
    SELECT i.amount_cents, r.parent_id
    FROM installments i JOIN registrations r ON r.id = i.registration_id
    WHERE i.organization_id = p_org AND i.status = 'paid'
      AND (p_from IS NULL OR i.paid_at >= p_from)
      AND (p_to   IS NULL OR i.paid_at <  p_to)
      AND (p_term IS NULL OR r.program_id IN (SELECT id FROM term_prog))
  ),
  ref AS (
    SELECT rf.amount_cents
    FROM refunds rf
    WHERE rf.organization_id = p_org AND rf.status = 'succeeded'
      AND (p_from IS NULL OR rf.succeeded_at >= p_from)
      AND (p_to   IS NULL OR rf.succeeded_at <  p_to)
      AND (p_term IS NULL OR rf.registration_id IN
            (SELECT r.id FROM registrations r WHERE r.program_id IN (SELECT id FROM term_prog)))
  ),
  inst_pending AS (
    SELECT i.amount_cents
    FROM installments i
    WHERE i.organization_id = p_org AND i.status = 'pending'
      AND (p_term IS NULL OR i.registration_id IN
            (SELECT r.id FROM registrations r WHERE r.program_id IN (SELECT id FROM term_prog)))
  ),
  ext AS (
    SELECT r.id
    FROM registrations r
    WHERE r.organization_id = p_org AND r.payment_method IS NULL
      AND (p_from IS NULL OR r.registered_at >= p_from)
      AND (p_to   IS NULL OR r.registered_at <  p_to)
      AND (p_term IS NULL OR r.program_id IN (SELECT id FROM term_prog))
  ),
  paid_families AS (
    SELECT parent_id FROM pif       WHERE parent_id IS NOT NULL
    UNION
    SELECT parent_id FROM inst_paid WHERE parent_id IS NOT NULL
  )
  SELECT
    (COALESCE((SELECT SUM(amount_cents) FROM pif),0)
      + COALESCE((SELECT SUM(amount_cents) FROM inst_paid),0)
      - COALESCE((SELECT SUM(amount_cents) FROM ref),0))::bigint,
    COALESCE((SELECT SUM(amount_cents) FROM ref),0)::bigint,
    COALESCE((SELECT SUM(amount_cents) FROM inst_pending),0)::bigint,
    (SELECT COUNT(*) FROM paid_families)::bigint,
    (SELECT COUNT(*) FROM ext)::bigint,
    EXISTS (SELECT 1 FROM registrations r
            WHERE r.organization_id = p_org AND r.payment_method = 'stripe'
              AND r.payment_status IN ('paid','partial','refunded')),
    -- STILL OWED = active OR refund_pending. A credit the operator has promised
    -- to pay back but has not paid is exactly as owed as one they have not
    -- touched, and this figure is the one that must never quietly drop.
    COALESCE((SELECT SUM(fc.amount_cents) FROM family_credits fc
              WHERE fc.organization_id = p_org
                AND fc.status IN ('active', 'refund_pending')),0)::bigint;
END
$function$;

revoke all     on function public.get_revenue_summary(uuid, timestamptz, timestamptz, text) from public;
revoke execute on function public.get_revenue_summary(uuid, timestamptz, timestamptz, text) from anon;
grant  execute on function public.get_revenue_summary(uuid, timestamptz, timestamptz, text) to authenticated;
grant  execute on function public.get_revenue_summary(uuid, timestamptz, timestamptz, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. SETTLE - AND IT IS REVERSIBLE
-- ---------------------------------------------------------------------------
-- Callable by the operator directly: no Stripe call and no email here, only a
-- status and a ledger line, so an edge function would add a deploy-order
-- contract and a second place to authorise for nothing. It proves the money bar
-- ITSELF, the shape program_message_recipients uses.
--
-- IT DOES NOT SET 'refunded'. Only `close_refund_pending_credit` does, and only
-- after money has actually moved. Nothing an operator can click may assert that
-- a family was paid.
--
-- REVERSIBLE, because the previous version was not and a mis-click between two
-- deliberately equal-weight buttons was permanent - reintroducing the
-- by-hand database edit this whole chunk existed to remove.
create or replace function public.settle_family_credit(
  p_credit_id  uuid,
  p_new_status text,
  p_note       text default null
)
returns table (
  credit_id    uuid,
  status       text,
  amount_cents integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org     uuid;
  v_status  text;
  v_amt     integer;
  v_reg     uuid;
  v_role    text;
  v_actor   uuid;
  v_applied integer;
begin
  -- 'refunded' is NOT settable here (see above). 'spent' is not either: it is
  -- written by the checkout path, and unwinding it means putting money back on
  -- a registration, which is a different job with a different ledger line.
  if p_new_status is null
     or p_new_status not in ('void', 'refund_pending', 'active') then
    raise exception 'settle_family_credit: % is not a status this function can set; use void, refund_pending or active', coalesce(p_new_status, 'null')
      using errcode = 'FC007';
  end if;

  select fc.organization_id, fc.status, fc.amount_cents, fc.source_registration_id
    into v_org, v_status, v_amt, v_reg
  from public.family_credits fc
  where fc.id = p_credit_id;

  if v_org is null then
    raise exception 'settle_family_credit: credit % does not exist', p_credit_id
      using errcode = 'FC006';
  end if;

  -- AUTHZ. Read the JWT role defensively - a failure to PARSE a claim must
  -- never become a failure to AUTHORISE. service_role is edge functions, which
  -- authorise their own callers before they get here.
  begin
    v_role := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '');
  exception when others then
    v_role := '';
  end;

  v_actor := auth.uid();

  if v_role <> 'service_role' then
    if v_actor is null
       or not (can_handle_money(v_org) or is_platform_admin()) then
      raise exception 'settle_family_credit: not authorised for organisation %', v_org
        using errcode = 'FC008';
    end if;
  end if;

  perform pg_advisory_xact_lock(
    hashtext('family_credit:' || coalesce(v_reg::text, p_credit_id::text))
  );

  -- RE-READ UNDER THE LOCK, and compare with IS DISTINCT FROM. `v_status <>
  -- 'active'` was NULL-blind: a cascade delete between the two reads left
  -- v_status NULL, `NULL <> 'active'` is NULL, and the IF took the FALSE branch
  -- - so the guard did not fire, the UPDATE matched nothing, and the movement
  -- insert died on a raw foreign-key error the caller could not interpret.
  select fc.status into v_status
  from public.family_credits fc
  where fc.id = p_credit_id;

  if v_status is null then
    raise exception 'settle_family_credit: credit % disappeared while being settled', p_credit_id
      using errcode = 'FC006';
  end if;

  -- WHAT MAY FOLLOW WHAT. Ending is only from 'active'; 'active' is only
  -- reachable back from an ending this function itself made, which is the undo.
  if p_new_status in ('void', 'refund_pending') and v_status is distinct from 'active' then
    raise exception 'settle_family_credit: credit % is %; only an active credit can be ended', p_credit_id, v_status
      using errcode = 'FC009';
  end if;
  if p_new_status = 'active' and v_status not in ('void', 'refund_pending') then
    raise exception 'settle_family_credit: credit % is %; only a voided or refund-pending credit can be reopened', p_credit_id, v_status
      using errcode = 'FC009';
  end if;

  -- A PARTLY SPENT CREDIT IS NOT WORTH ITS FACE VALUE. 'active' means "some or
  -- all of it is still available", so releasing amount_cents would release
  -- money already applied to another registration. Nothing writes 'applied'
  -- yet; the guard goes in now because this function is the single entry point
  -- when the checkout path lands, and a wrong release there is unrecoverable.
  select coalesce(sum(m.amount_cents), 0) into v_applied
  from public.family_credit_movements m
  where m.credit_id = p_credit_id and m.kind = 'applied';

  if v_applied > 0 then
    raise exception 'settle_family_credit: credit % has % already applied; settle the remaining balance instead', p_credit_id, v_applied
      using errcode = 'FC010';
  end if;

  update public.family_credits
     set status = p_new_status,
         updated_at = now()
   where id = p_credit_id;

  -- ALWAYS 'adjusted'. No money moves in this function, so the ledger must not
  -- carry a 'refunded' line, which the schema defines as "paid back to the
  -- family's original payment method". The previous version wrote that at the
  -- moment of intent, while the screen beside it said no money was sent.
  insert into public.family_credit_movements (
    credit_id, organization_id, amount_cents, kind, registration_id, note, actor_user_id
  )
  values (
    p_credit_id, v_org, v_amt, 'adjusted', null,
    coalesce(p_note, '') || case
      when p_new_status = 'refund_pending' then ' [marked to be refunded]'
      when p_new_status = 'void'           then ' [voided]'
      else ' [reopened]'
    end,
    v_actor
  );

  credit_id := p_credit_id; status := p_new_status; amount_cents := v_amt;
  return next;
end;
$$;

revoke all     on function public.settle_family_credit(uuid, text, text) from public;
revoke execute on function public.settle_family_credit(uuid, text, text) from anon;
grant  execute on function public.settle_family_credit(uuid, text, text) to authenticated;
grant  execute on function public.settle_family_credit(uuid, text, text) to service_role;

comment on function public.settle_family_credit(uuid, text, text) is
  'Moves one credit between active, void and refund_pending, and writes an adjusted movement naming the operator. It can NEVER set refunded - only close_refund_pending_credit does that, after money has actually moved. Reversible: an ending can be reopened to active. FC006 no such credit or it vanished mid-settle, FC007 bad target status, FC008 not authorised, FC009 illegal transition, FC010 credit is partly spent.';

-- ---------------------------------------------------------------------------
-- 5. THE ONLY THING THAT MAY SAY A FAMILY WAS PAID
-- ---------------------------------------------------------------------------
-- service_role ONLY, because the sole honest caller is the refund path, after
-- Stripe has confirmed. It closes at most what was actually refunded, so a
-- partial refund leaves the rest still owed rather than discharging the lot.
create or replace function public.close_refund_pending_credit(
  p_registration_id uuid,
  p_refunded_cents  integer
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_closed integer := 0;
  r        record;
  v_budget integer := coalesce(p_refunded_cents, 0);
begin
  if v_budget <= 0 or p_registration_id is null then
    return 0;
  end if;

  perform pg_advisory_xact_lock(hashtext('family_credit:' || p_registration_id::text));

  -- Oldest first, so a family with two pending credits has the one they have
  -- been waiting on longest discharged first.
  for r in
    select fc.id, fc.organization_id, fc.amount_cents
    from public.family_credits fc
    where fc.source_registration_id = p_registration_id
      and fc.status = 'refund_pending'
    order by fc.created_at asc
  loop
    exit when v_budget < r.amount_cents;

    update public.family_credits
       set status = 'refunded', updated_at = now()
     where id = r.id;

    -- registration_id IS set here, unlike the adjusted lines: this movement is
    -- the one that can be joined to the refunds row that justifies it.
    insert into public.family_credit_movements (
      credit_id, organization_id, amount_cents, kind, registration_id, note, actor_user_id
    )
    values (
      r.id, r.organization_id, r.amount_cents, 'refunded', p_registration_id,
      'closed by a refund on this registration', null
    );

    v_budget := v_budget - r.amount_cents;
    v_closed := v_closed + 1;
  end loop;

  return v_closed;
end;
$$;

revoke all     on function public.close_refund_pending_credit(uuid, integer) from public;
revoke execute on function public.close_refund_pending_credit(uuid, integer) from anon;
revoke execute on function public.close_refund_pending_credit(uuid, integer) from authenticated;
grant  execute on function public.close_refund_pending_credit(uuid, integer) to service_role;

comment on function public.close_refund_pending_credit(uuid, integer) is
  'Discharges refund_pending credits on a registration once a refund has actually succeeded, up to the amount refunded, writing the refunded movement that can be joined to the refunds row. service_role only: nothing an operator clicks may assert that a family was paid.';

-- ---------------------------------------------------------------------------
-- 6. AN ENDED CREDIT IS NOT A USABLE IDEMPOTENCY KEY
-- ---------------------------------------------------------------------------
-- The guard singled out 'void' and explained why: a worthless credit "would
-- come back as a success and withdraw a family against a credit worth nothing".
-- 'refunded' and 'refund_pending' are now exactly that hazard and were passing.
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

  if p_idempotency_key is not null then
    select fc.id, fc.amount_cents, fc.status, fc.reason
      into v_id, v_amt, v_status, v_reason
    from public.family_credits fc
    where fc.organization_id = p_organization_id
      and fc.idempotency_key = p_idempotency_key
    limit 1;

    if v_id is not null then
      if v_status in ('void', 'refunded', 'refund_pending') then
        raise exception 'issue_family_credit: idempotency key % on organisation % belongs to a credit that has been ended (%); use a new key',
          p_idempotency_key, p_organization_id, v_status
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
