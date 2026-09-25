-- 20260925a_spend_a_credit.sql
-- Credits chunk 3b: a family can SPEND a credit at checkout.
--
-- WHAT THIS ADDS, and the one idea the whole file turns on:
--
--   SPENDABLE BALANCE IS ARITHMETIC, NEVER A STATUS. A credit's remaining
--   balance is amount_cents minus what has been taken off it, read from
--   family_credit_movements. `status` is a LABEL that follows the arithmetic;
--   nothing in the spend path ever asks status whether there is money left.
--
--   This is deliberate and it is the lesson from the void/cash-out work that
--   was withdrawn on 2026-09-25. That design made one status list answer two
--   different questions - "does this block a refund on its source
--   registration?" and "does the business still owe it?" - and five of eight
--   review findings traced to exactly that. The two questions are now
--   answered by two different things:
--
--     does it block a refund on the SOURCE registration?
--         registration_available_cents, which reads family_credits.status
--         <> 'void'. UNCHANGED by this migration, deliberately: spending a
--         credit does not un-owe the refund it came from.
--
--     is there money left to SPEND?
--         family_credit_balance_cents, which reads movements and does not
--         look at status at all.
--
--   Where status IS consulted for spending, it is a POSITIVE allowlist
--   (status = 'active'), never `not in (...)`. A list of things to exclude
--   silently admits every value added later; a list of things to admit
--   fails closed on them.
--
-- THE POT AND ITS LOCK. Chunk 2's pot was one registration's refundable
-- amount, locked on 'family_credit:<registration_id>'. This pot is a
-- different one - a family's balance at one business - so it takes its own
-- key, 'family_credit_balance:<org>:<parent>'. That is not a second spelling
-- of the same rule; it is a second pot.
--
--   WHO ELSE DRAINS THIS POT? Nobody. issue_family_credit only ADDS to it,
--   and restore_family_credit_for_registration below only ADDS. Checkout is
--   the sole drainer, so serialising checkout against itself is sufficient.
--   If a second drainer is ever written it MUST take this same key - a lock
--   only serialises the callers that all take it.
--
-- WHY A HOLD EXISTS AT ALL. When a credit covers the order completely there
-- is no Stripe session and no window: the credit is applied in the same
-- transaction that confirms the registration. When it covers only part, a
-- Stripe session is created and the family may take minutes to pay. Without
-- a hold, two browser tabs both read the same balance, both create a session
-- discounted by the full credit, and both pay - the same double-spend shape
-- that the withdrawn work proved. So a partial spend RESERVES first and
-- CAPTURES on payment.
--
--   A HOLD IS NOT A PROMISE. capture re-derives the balance under the lock
--   rather than trusting that its own reservation is still good, because a
--   reservation can expire between session creation and payment. Trusting
--   the hold would be trusting a status again.
--
-- CREDIT IS DRAWN PER REGISTRATION, NOT PER CART. A cart can hold three
-- children. If the whole draw were stamped on one registration, refunding a
-- DIFFERENT child would give back nothing and refunding that one would give
-- back the whole cart's credit. So each registration draws its own share,
-- exactly as create-checkout already allocates the enrops fee per line, and
-- the refund path can then return precisely what that registration consumed.

begin;

-- ---------------------------------------------------------------------------
-- 1. MOVEMENTS GROW TWO KINDS AND TWO COLUMNS
-- ---------------------------------------------------------------------------
-- 'reserved' - held for an unpaid checkout session; consumes balance until it
--              expires or is released.
-- 'restored' - given BACK to the family, because a registration they funded
--              with credit was refunded. The only kind that ADDS.
--
-- amount_cents stays strictly positive on every kind (the existing CHECK).
-- 'restored' is expressed as a positive amount of a different kind rather
-- than a negative amount of the same kind, so the audit trail reads
-- "applied 240, restored 240" instead of two rows that cancel to nothing.

alter table public.family_credit_movements
  drop constraint if exists family_credit_movements_kind_known;

alter table public.family_credit_movements
  add constraint family_credit_movements_kind_known
  check (kind = any (array[
    'applied'::text,     -- spent on a registration
    'reserved'::text,    -- held for an open checkout session
    'restored'::text,    -- given back (credit-funded registration refunded)
    'refunded'::text,    -- cashed out to a card. NOT BUILT - see the note below
    'adjusted'::text     -- operator correction downwards
  ]));

-- 'refunded' stays in the allowlist because chunk 2 shipped it and
-- registration_available_cents has always tolerated it. NOTHING WRITES IT.
-- Cash-out was withdrawn on 2026-09-25 with a proven double-spend; if it is
-- ever rebuilt it must take the balance lock above like every other drainer.

alter table public.family_credit_movements
  add column if not exists application_key text,
  add column if not exists expires_at timestamptz;

comment on column public.family_credit_movements.application_key is
  'Idempotency key for one checkout''s draw on this credit. A Stripe session id for a part-paid order, or credit:<registration_id> for an order the credit covered outright. One checkout can draw on several credits AND on behalf of several registrations, so identity is (credit, key, registration) - see the unique index.';

comment on column public.family_credit_movements.expires_at is
  'Set on kind=''reserved'' only. Past this instant the hold stops consuming balance, so a checkout the family abandoned cannot strand their own money. Never trusted on its own: capture re-derives the balance under the lock.';

-- IDEMPOTENCY. A webhook retry, a double-clicked button and a resumed session
-- all arrive as the same key. The registration is part of the identity because
-- one session draws on one credit once PER CHILD, and those draws are
-- genuinely different rows - not duplicates of each other.
create unique index if not exists family_credit_movements_credit_key_reg_uniq
  on public.family_credit_movements (credit_id, application_key, registration_id)
  where application_key is not null and registration_id is not null;

-- The balance function and the capture/release paths both filter on these.
create index if not exists family_credit_movements_credit_id_idx
  on public.family_credit_movements (credit_id);

create index if not exists family_credit_movements_application_key_idx
  on public.family_credit_movements (application_key)
  where application_key is not null;

-- Restores and applications are read back per registration on the refund path.
create index if not exists family_credit_movements_registration_id_idx
  on public.family_credit_movements (registration_id)
  where registration_id is not null;

-- ---------------------------------------------------------------------------
-- 2. THE BALANCE. One implementation, read by everything.
-- ---------------------------------------------------------------------------
-- A LIVE reservation consumes; an EXPIRED one does not. That single
-- `expires_at > now()` is what stops an abandoned cart from holding a
-- family's money forever when no webhook ever arrives to release it.

create or replace function public.family_credit_balance_cents(p_credit_id uuid)
returns integer
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select greatest(
    coalesce((select fc.amount_cents from public.family_credits fc
              where fc.id = p_credit_id), 0)
    - coalesce((
        select sum(m.amount_cents) from public.family_credit_movements m
        where m.credit_id = p_credit_id
          and (
            m.kind in ('applied', 'refunded', 'adjusted')
            or (m.kind = 'reserved'
                and m.expires_at is not null
                and m.expires_at > now())
          )
      ), 0)
    + coalesce((
        select sum(m.amount_cents) from public.family_credit_movements m
        where m.credit_id = p_credit_id and m.kind = 'restored'
      ), 0),
    0);
$function$;

comment on function public.family_credit_balance_cents(uuid) is
  'What is left on ONE credit, in cents. amount_cents, less applied/refunded/adjusted and any UNEXPIRED reservation, plus anything restored. The single implementation - apply, capture and the parent portal all read it. Deliberately does not consult family_credits.status: status is a label that follows this number, never the source of it. greatest(...,0) so a data error reads as zero spendable rather than as a negative that would inflate a later sum.';

-- ---------------------------------------------------------------------------
-- 3. WHAT A FAMILY CAN SPEND AT ONE BUSINESS
-- ---------------------------------------------------------------------------
-- Keyed on (organization_id, parent_id) because ten parents on production
-- have children at TWO businesses. A parent-keyed balance would let a credit
-- issued by one operator be spent at another's - one business paying another
-- business's refund.

create or replace function public.family_credit_available_cents(
  p_organization_id uuid,
  p_parent_id uuid
)
returns integer
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(sum(public.family_credit_balance_cents(fc.id)), 0)::integer
  from public.family_credits fc
  where fc.organization_id = p_organization_id
    and fc.parent_id = p_parent_id
    and fc.status = 'active';
$function$;

comment on function public.family_credit_available_cents(uuid, uuid) is
  'Total spendable credit for one family at ONE business, in cents. Keyed on (organization_id, parent_id) and never on parent alone: ten production parents have children at two businesses, and a parent-keyed balance would let one operator''s credit be spent at another''s. Sums family_credit_balance_cents over status=''active'' credits - a positive allowlist, so a status added later is not silently spendable.';

-- ---------------------------------------------------------------------------
-- 3b. WHAT THE FAMILY THEMSELVES SEES
-- ---------------------------------------------------------------------------
-- Chunk 3a's portal card summed family_credits.amount_cents over status
-- 'active'. That was the whole truth right up until this migration, because
-- nothing could take money OFF a credit - a credit was whole or it was gone.
--
-- IT IS NOW A LIE IN THE FAMILY'S FAVOUR, which is the worst direction. Spend
-- $150 of a $240 credit and the credit stays 'active' with $90 left, while the
-- card still reads $240. The family plans around money they have spent.
--
-- So the portal is moved onto the same arithmetic as the spend path. This
-- wrapper exists rather than granting the two-argument function to
-- `authenticated`, because that one takes a parent_id and would let any
-- signed-in user read any other family's balance. This one takes no parent at
-- all: it resolves the caller through current_parent_id(), exactly as the
-- parents_see_own_regs policy does, so there is no argument to tamper with.
--
-- It DELEGATES rather than reimplements. One balance rule, one place - a second
-- spelling in JavaScript is how the refund-rate figure came to disagree with
-- itself across an email and a screen.

create or replace function public.my_family_credit_balance_cents(
  p_organization_id uuid
)
returns integer
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select case
           when public.current_parent_id() is null then 0
           else public.family_credit_available_cents(p_organization_id, public.current_parent_id())
         end;
$function$;

comment on function public.my_family_credit_balance_cents(uuid) is
  'The signed-in family''s own spendable credit at one business, for the parent portal. Takes no parent_id on purpose - it resolves the caller via current_parent_id(), so there is no argument a signed-in user could point at another family. Delegates to family_credit_available_cents so the balance rule has exactly one implementation. Returns 0 for a caller who is not a parent.';

-- ---------------------------------------------------------------------------
-- 4. SPENDING IT. The guard lives IN the write.
-- ---------------------------------------------------------------------------
-- Called ONCE PER REGISTRATION with that registration's share of the order.
--
-- p_kind is 'reserved' (part-paid order, captured when Stripe says paid) or
-- 'applied' (the credit covers the order outright, so there is no session to
-- wait for and the money moves now).
--
-- FIFO by created_at: the oldest credit is spent first. With no expiry dates
-- nothing forces an order, but oldest-first is what a family expects and it
-- keeps the result deterministic for tests.

create or replace function public.apply_family_credit(
  p_organization_id uuid,
  p_parent_id uuid,
  p_registration_id uuid,
  p_amount_needed_cents integer,
  p_application_key text,
  p_kind text,
  p_hold_minutes integer default 1440
)
returns table(applied_cents integer, already_existed boolean)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_total      integer := 0;
  v_existing   integer := 0;
  v_n          integer := 0;
  v_take       integer;
  v_left       integer;
  v_expires    timestamptz;
  v_reg_org    uuid;
  v_reg_parent uuid;
  r            record;
begin
  if p_kind is null or p_kind not in ('reserved', 'applied') then
    raise exception 'apply_family_credit: p_kind must be reserved or applied, got %', p_kind
      using errcode = 'FC012';
  end if;
  if p_application_key is null or length(trim(p_application_key)) = 0 then
    raise exception 'apply_family_credit: an application key is required'
      using errcode = 'FC012';
  end if;
  if p_registration_id is null then
    raise exception 'apply_family_credit: a registration is required - credit is drawn per registration, not per cart'
      using errcode = 'FC012';
  end if;
  if p_amount_needed_cents is null or p_amount_needed_cents < 0 then
    raise exception 'apply_family_credit: p_amount_needed_cents must be non-negative, got %',
      p_amount_needed_cents using errcode = 'FC012';
  end if;
  if p_organization_id is null or p_parent_id is null then
    raise exception 'apply_family_credit: organisation and parent are both required'
      using errcode = 'FC012';
  end if;

  -- THE ORG/PARENT PROOF, the same shape issue_family_credit uses. The caller
  -- holds the service-role key and RLS will not stop it, so the registration
  -- is checked against the org and parent whose pot is about to be drained.
  -- Without this a caller could spend one family's credit on another family's
  -- registration and every row would still look well-formed.
  select r2.organization_id, r2.parent_id into v_reg_org, v_reg_parent
  from public.registrations r2 where r2.id = p_registration_id;

  if v_reg_org is null then
    raise exception 'apply_family_credit: registration % does not exist', p_registration_id
      using errcode = 'FC013';
  end if;
  if v_reg_org <> p_organization_id or v_reg_parent is distinct from p_parent_id then
    raise exception 'apply_family_credit: registration % belongs to organisation %/parent %, not %/%',
      p_registration_id, v_reg_org, v_reg_parent, p_organization_id, p_parent_id
      using errcode = 'FC013';
  end if;

  -- THE POT'S OWN LOCK. Held for the rest of the transaction, so the balance
  -- read below and the inserts that follow cannot be interleaved with another
  -- checkout for the same family at the same business.
  perform pg_advisory_xact_lock(
    hashtext('family_credit_balance:' || p_organization_id::text || ':' || p_parent_id::text));

  -- IDEMPOTENCY IS ANSWERED FIRST, under the lock, before anything is read or
  -- written. Scoped to (key, REGISTRATION): one session draws once per child,
  -- and without the registration term the second child's call would see the
  -- first child's rows and silently apply nothing.
  select coalesce(sum(m.amount_cents), 0), count(*)
    into v_existing, v_n
  from public.family_credit_movements m
  join public.family_credits fc on fc.id = m.credit_id
  where m.application_key = p_application_key
    and m.registration_id = p_registration_id
    and fc.organization_id = p_organization_id
    and fc.parent_id = p_parent_id
    and m.kind in ('reserved', 'applied');

  if v_n > 0 then
    applied_cents := v_existing;
    already_existed := true;
    return next;
    return;
  end if;

  if p_amount_needed_cents = 0 then
    applied_cents := 0;
    already_existed := false;
    return next;
    return;
  end if;

  v_left := p_amount_needed_cents;
  v_expires := case when p_kind = 'reserved'
                    then now() + make_interval(mins => greatest(coalesce(p_hold_minutes, 1440), 1))
                    else null end;

  -- Oldest credit first. `for update` on family_credits is belt-and-braces
  -- behind the advisory lock: it also serialises against any future writer
  -- that touches the row without taking the balance key.
  for r in
    select fc.id
    from public.family_credits fc
    where fc.organization_id = p_organization_id
      and fc.parent_id = p_parent_id
      and fc.status = 'active'
    order by fc.created_at asc, fc.id asc
    for update
  loop
    exit when v_left <= 0;

    -- Read the balance INSIDE the loop, not in the cursor's select list: the
    -- insert below changes it, and a value computed when the cursor was
    -- planned would be stale for every row after the first.
    v_take := least(public.family_credit_balance_cents(r.id), v_left);
    continue when v_take <= 0;

    insert into public.family_credit_movements (
      credit_id, organization_id, amount_cents, kind,
      registration_id, application_key, expires_at, note
    ) values (
      r.id, p_organization_id, v_take, p_kind,
      p_registration_id, p_application_key, v_expires,
      case when p_kind = 'reserved'
           then 'held for checkout'
           else 'spent at checkout' end
    );

    v_total := v_total + v_take;
    v_left  := v_left - v_take;

    -- The label follows the arithmetic. Only an OUTRIGHT spend can settle a
    -- credit; a reservation is not a spend, and marking it 'spent' would be
    -- the exact mistake of letting a status answer a question it cannot.
    if p_kind = 'applied' and public.family_credit_balance_cents(r.id) <= 0 then
      update public.family_credits
         set status = 'spent', updated_at = now()
       where id = r.id;
    end if;
  end loop;

  applied_cents := v_total;
  already_existed := false;
  return next;
end;
$function$;

comment on function public.apply_family_credit(uuid, uuid, uuid, integer, text, text, integer) is
  'Draws up to p_amount_needed_cents off a family''s credits at ONE business for ONE registration, oldest first, and returns what it actually got - which may be less, and the caller must charge the difference. Proves the registration belongs to that org AND parent (FC013), takes the balance pot''s lock (family_credit_balance:<org>:<parent>), answers idempotency under it scoped to (key, registration), then re-derives every credit''s balance from movements inside the same transaction. p_kind=''reserved'' holds for an unpaid Stripe session, ''applied'' spends outright when the credit covers the order. FC012 bad input. Checkout is this pot''s only drainer; any future drainer must take the same key.';

-- ---------------------------------------------------------------------------
-- 5. CAPTURE AND RELEASE
-- ---------------------------------------------------------------------------
-- Capture turns a hold into a spend when Stripe says the family paid.
--
-- IT RE-DERIVES THE BALANCE RATHER THAN TRUSTING ITS OWN RESERVATION. A hold
-- can expire while the family is on the Stripe page; by then the balance may
-- have been spent elsewhere. Converting blindly would mint money.
--
-- THE ADD-BACK IS CONDITIONAL ON THE HOLD STILL BEING LIVE, and this is the
-- subtle half. family_credit_balance_cents already subtracts a LIVE hold, so
-- to ask "what room is there if this hold did not exist" the hold has to be
-- added back - but only if it was subtracted. Adding back an EXPIRED hold
-- (which the balance never subtracted) double-counts it, and would capture
-- cents that another checkout has already spent.

create or replace function public.capture_family_credit_hold(
  p_application_key text
)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_captured integer := 0;
  v_room     integer;
  v_take     integer;
  r          record;
  v_org      uuid;
  v_parent   uuid;
begin
  if p_application_key is null or length(trim(p_application_key)) = 0 then
    raise exception 'capture_family_credit_hold: an application key is required'
      using errcode = 'FC012';
  end if;

  select fc.organization_id, fc.parent_id into v_org, v_parent
  from public.family_credit_movements m
  join public.family_credits fc on fc.id = m.credit_id
  where m.application_key = p_application_key
  limit 1;

  -- Nothing was held under this key. Not an error: an all-cash order has no
  -- credit leg, and the webhook calls this for every session.
  if v_org is null then
    return 0;
  end if;

  perform pg_advisory_xact_lock(
    hashtext('family_credit_balance:' || v_org::text || ':' || v_parent::text));

  for r in
    select m.id, m.credit_id, m.amount_cents,
           (m.expires_at is not null and m.expires_at > now()) as still_live
    from public.family_credit_movements m
    where m.application_key = p_application_key
      and m.kind = 'reserved'
    order by m.created_at asc, m.id asc
    for update
  loop
    v_room := public.family_credit_balance_cents(r.credit_id)
              + case when r.still_live then r.amount_cents else 0 end;
    v_take := least(greatest(v_room, 0), r.amount_cents);

    if v_take <= 0 then
      -- The hold lapsed and the money went elsewhere. Drop the reservation;
      -- the caller sees a smaller captured total than it reserved and decides
      -- what to do about the shortfall.
      delete from public.family_credit_movements where id = r.id;
      continue;
    end if;

    update public.family_credit_movements
       set kind = 'applied',
           amount_cents = v_take,
           expires_at = null,
           note = 'spent at checkout'
     where id = r.id;

    v_captured := v_captured + v_take;

    if public.family_credit_balance_cents(r.credit_id) <= 0 then
      update public.family_credits
         set status = 'spent', updated_at = now()
       where id = r.credit_id;
    end if;
  end loop;

  return v_captured;
end;
$function$;

comment on function public.capture_family_credit_hold(text) is
  'Turns the reservations under one application key into spends, when Stripe confirms the family paid. Returns the cents actually captured, which can be LESS than was held if a hold lapsed and the money went elsewhere. Re-derives each credit''s balance under the pot lock instead of trusting its own hold; the balance already subtracts a LIVE hold, so the hold is added back only when it is still live - adding back an expired one would double-count and mint money. Returns 0 for a key that held nothing, the normal case for an all-cash order.';

create or replace function public.release_family_credit_hold(
  p_application_key text
)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_released integer := 0;
  v_org      uuid;
  v_parent   uuid;
begin
  if p_application_key is null or length(trim(p_application_key)) = 0 then
    raise exception 'release_family_credit_hold: an application key is required'
      using errcode = 'FC012';
  end if;

  select fc.organization_id, fc.parent_id into v_org, v_parent
  from public.family_credit_movements m
  join public.family_credits fc on fc.id = m.credit_id
  where m.application_key = p_application_key
  limit 1;

  if v_org is null then
    return 0;
  end if;

  perform pg_advisory_xact_lock(
    hashtext('family_credit_balance:' || v_org::text || ':' || v_parent::text));

  -- ONLY reservations. An 'applied' row under this key means the family paid
  -- and the money is spent; deleting it here would hand back credit they have
  -- already had the benefit of.
  with gone as (
    delete from public.family_credit_movements m
    where m.application_key = p_application_key
      and m.kind = 'reserved'
    returning m.amount_cents
  )
  select coalesce(sum(amount_cents), 0) into v_released from gone;

  return v_released;
end;
$function$;

comment on function public.release_family_credit_hold(text) is
  'Gives back the credit held under one application key when the checkout did not complete (session expired or the family cancelled). Returns the cents released. Deletes ONLY kind=''reserved'': an ''applied'' row under the same key means the family paid, and removing it would return credit they have already spent. Safe to call for a key that held nothing.';

-- ---------------------------------------------------------------------------
-- 5b. THE ZERO-DOLLAR CHECKOUT, WHERE CREDIT COVERS THE WHOLE ORDER
-- ---------------------------------------------------------------------------
-- There is no Stripe session on this path, so there is no webhook coming to
-- finish the job: the credit is spent and the seat is confirmed here or not
-- at all. Doing that as two statements from an edge function leaves a window
-- in which one has happened and the other has not, and BOTH torn states cost
-- somebody real money:
--
--   credit spent, registration not confirmed -> the family paid and has no seat
--   registration confirmed, credit not spent -> the business gave a class away
--
-- Neither is acceptable and there is no "safer half" to order first, so the
-- pair is not ordered - it is made atomic. A plpgsql function is one
-- transaction, so the credit movement and the status change commit together
-- or neither does.
--
-- Scoped to ONE registration deliberately. A three-child cart calls this three
-- times, and if the second call fails the first child is confirmed with their
-- credit correctly spent while the third is untouched - a partial cart, which
-- an operator can read and finish. Wrapping the whole cart would instead make
-- one child's problem silently undo two children who were already fine.

create or replace function public.confirm_registration_paid_by_credit(
  p_organization_id uuid,
  p_parent_id uuid,
  p_registration_id uuid,
  p_amount_cents integer,
  p_application_key text
)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_applied integer;
begin
  -- apply_family_credit carries the org/parent proof, the pot lock and the
  -- idempotency answer. Calling it rather than repeating any of that is what
  -- keeps one rule in one place; this function adds only the confirmation.
  select a.applied_cents into v_applied
  from public.apply_family_credit(
    p_organization_id, p_parent_id, p_registration_id,
    p_amount_cents, p_application_key, 'applied', null
  ) a;

  -- The credit must actually cover it. If the balance moved between the
  -- edge function's read and this write, the honest answer is to fail the
  -- whole transaction - the caller then falls back to charging the family -
  -- rather than confirm a seat that nothing paid for.
  if coalesce(v_applied, 0) < p_amount_cents then
    raise exception 'confirm_registration_paid_by_credit: credit covered only % of % on registration %',
      coalesce(v_applied, 0), p_amount_cents, p_registration_id
      using errcode = 'FC014';
  end if;

  update public.registrations
     set status = 'confirmed',
         payment_status = 'paid'
   where id = p_registration_id;

  return v_applied;
end;
$function$;

comment on function public.confirm_registration_paid_by_credit(uuid, uuid, uuid, integer, text) is
  'Spends credit on ONE registration and confirms it, atomically, for the checkout where credit covers the whole order and no Stripe session exists. Both torn states cost somebody money - credit spent with no seat, or a seat given away free - so the pair is made atomic rather than ordered. Raises FC014 and rolls back if the credit no longer covers the amount, leaving the caller to charge instead. Delegates the org/parent proof, the pot lock and idempotency to apply_family_credit.';

-- ---------------------------------------------------------------------------
-- 6. GIVING IT BACK WHEN A CREDIT-FUNDED REGISTRATION IS REFUNDED
-- ---------------------------------------------------------------------------
-- THE SEAM THIS CLOSES. A family funds a $400 registration with $240 of
-- credit and $160 on a card. The operator refunds it. Stripe only ever saw
-- $160, so registration_available_cents - which is a CASH ceiling and stays
-- one - correctly offers $160 back. Without this function the $240 simply
-- vanishes: the family paid it, the class did not run, and nothing on either
-- side of the ledger remembers.
--
-- So the credit leg is returned as credit and the cash leg as cash. That also
-- keeps the two ledgers from contaminating each other: no cash is invented
-- for money that never reached Stripe, and no credit is invented for money
-- that did.
--
-- BOUNDED PER CREDIT by what was actually applied to THIS registration, less
-- anything already restored for it, so a repeat call cannot give back more
-- than the family put in. That bound is the guard the withdrawn undo lacked -
-- it re-checked nothing, which is how three clicks produced $480 owed on a
-- $240 payment.

create or replace function public.restore_family_credit_for_registration(
  p_registration_id uuid,
  p_amount_cents integer,
  p_note text default null
)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_restored       integer := 0;
  v_left           integer;
  v_take           integer;
  v_already        integer;
  v_room           integer;
  v_org            uuid;
  v_parent         uuid;
  r                record;
begin
  if p_registration_id is null then
    raise exception 'restore_family_credit_for_registration: a registration is required'
      using errcode = 'FC012';
  end if;
  if p_amount_cents is null or p_amount_cents < 0 then
    raise exception 'restore_family_credit_for_registration: amount must be non-negative, got %',
      p_amount_cents using errcode = 'FC012';
  end if;
  if p_amount_cents = 0 then
    return 0;
  end if;

  select fc.organization_id, fc.parent_id into v_org, v_parent
  from public.family_credit_movements m
  join public.family_credits fc on fc.id = m.credit_id
  where m.registration_id = p_registration_id
    and m.kind = 'applied'
  limit 1;

  -- No credit was ever spent on this registration. Normal for the vast
  -- majority of refunds; the caller treats 0 as "nothing to give back".
  if v_org is null then
    return 0;
  end if;

  perform pg_advisory_xact_lock(
    hashtext('family_credit_balance:' || v_org::text || ':' || v_parent::text));

  v_left := p_amount_cents;

  for r in
    select m.credit_id, sum(m.amount_cents) as applied
    from public.family_credit_movements m
    where m.registration_id = p_registration_id
      and m.kind = 'applied'
    group by m.credit_id
    order by m.credit_id
  loop
    exit when v_left <= 0;

    -- Already given back on a previous call, for THIS registration and THIS
    -- credit. This is what makes a second refund attempt, or a retried
    -- webhook, unable to inflate the balance past what was taken.
    select coalesce(sum(m2.amount_cents), 0) into v_already
    from public.family_credit_movements m2
    where m2.registration_id = p_registration_id
      and m2.kind = 'restored'
      and m2.credit_id = r.credit_id;

    v_room := r.applied - v_already;
    continue when v_room <= 0;

    v_take := least(v_room, v_left);

    insert into public.family_credit_movements (
      credit_id, organization_id, amount_cents, kind, registration_id, note
    ) values (
      r.credit_id, v_org, v_take, 'restored', p_registration_id,
      coalesce(p_note, 'returned when the registration was refunded')
    );

    -- A credit that was marked 'spent' has money on it again, so the label has
    -- to follow the arithmetic back. Without this the balance functions would
    -- be right and the family would still see nothing, because every spendable
    -- read filters on status = 'active'.
    update public.family_credits
       set status = 'active', updated_at = now()
     where id = r.credit_id
       and status = 'spent';

    v_restored := v_restored + v_take;
    v_left := v_left - v_take;
  end loop;

  return v_restored;
end;
$function$;

comment on function public.restore_family_credit_for_registration(uuid, integer, text) is
  'Gives credit back when a registration the family funded with credit is refunded. Returns the cents restored. Bounded per credit by what was actually applied to THIS registration less what has already been restored for it, so a repeat call or a retried webhook cannot hand back more than the family put in. Re-activates a credit labelled ''spent'', because every spendable read filters on status=''active'' and the money is real again. Returns 0 when no credit funded this registration, which is the normal case.';

-- ---------------------------------------------------------------------------
-- 7. GRANTS
-- ---------------------------------------------------------------------------
-- `revoke from public` does NOT remove anon's EXECUTE - Supabase grants it
-- separately, and that is how parent email addresses leaked on 2026-08-20.
-- Both roles are revoked BY NAME, and the catalogue is read back after this
-- migration rather than assumed.
--
-- Every function here is called by an edge function holding the service-role
-- key, which bypasses grants entirely. Nothing needs anon or authenticated.
-- The two read-only balance functions are revoked too: the parent portal
-- reads its own credits through RLS on the TABLE, not through these.

revoke all on function public.family_credit_balance_cents(uuid) from public, anon, authenticated;
revoke all on function public.family_credit_available_cents(uuid, uuid) from public, anon, authenticated;
-- The portal wrapper is the ONE exception, and it is safe to grant precisely
-- because it takes no parent_id: it can only ever answer for the caller.
-- anon is still revoked BY NAME - a revoke from public does not remove it.
revoke all on function public.my_family_credit_balance_cents(uuid) from public, anon;
grant execute on function public.my_family_credit_balance_cents(uuid) to authenticated;
revoke all on function public.apply_family_credit(uuid, uuid, uuid, integer, text, text, integer) from public, anon, authenticated;
revoke all on function public.confirm_registration_paid_by_credit(uuid, uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.capture_family_credit_hold(text) from public, anon, authenticated;
revoke all on function public.release_family_credit_hold(text) from public, anon, authenticated;
revoke all on function public.restore_family_credit_for_registration(uuid, integer, text) from public, anon, authenticated;

commit;
