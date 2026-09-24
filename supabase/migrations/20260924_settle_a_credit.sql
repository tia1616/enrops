-- DEPLOY ORDER: this migration BEFORE the frontend. It only ADDS a function and
-- widens two exclusions, so it is inert until a screen calls it - a frontend
-- shipped first would call a function that does not exist and the button would
-- fail with a bare PostgREST 404. As always the order is a property of what the
-- change DEPENDS ON, not of the file type; see 20260923a for the sibling case
-- that needs the opposite.
--
-- NAMED BY CONTENT, NOT BY LETTER. 20260924a/b are already taken by two other
-- sessions' work, and the letters are not a sequence.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS FOR
-- ---------------------------------------------------------------------------
-- A credit could be issued and nothing else. There was no way to undo one
-- issued by mistake, and no way to honour "actually, I would rather have the
-- money" - because a credit CONSUMES the refundable ceiling, so an operator who
-- wanted to refund the family instead was refused by the very guard that stops
-- double-spending. Today the only fix is me editing the database by hand.
--
-- The schema already anticipated both endings and named them, so this uses them
-- rather than inventing a third:
--   status 'void'     - issued in error and withdrawn
--   status 'refunded' - the family took the money back instead (cash out)
-- and on the movements table, kind 'adjusted' is "an operator correction, which
-- is why note matters", kind 'refunded' is "paid back to the family's original
-- payment method".

-- ---------------------------------------------------------------------------
-- 1. A CREDIT THAT HAS BEEN PAID BACK MUST STOP CONSUMING THE CEILING
-- ---------------------------------------------------------------------------
-- Both readers subtracted every credit that is not 'void'. That was right while
-- 'refunded' was unreachable; it is wrong the moment it is not.
--
-- A 'refunded' credit has a refunds row standing for the same money. Counting
-- BOTH subtracts one payment twice: a family who paid $240, took a $240 credit
-- and then cashed it out would show a ceiling of MINUS $240, and every later
-- refund or credit on that registration would be refused for the life of the
-- record.
--
-- It also has to be this way round for the cash-out to be possible at all. The
-- operator marks the credit 'refunded' first, which releases the ceiling, and
-- the refund they then issue is what actually moves the money. While a credit
-- is still 'active' the ceiling is zero and the refund cannot be reserved.
--
-- INERT ON PRODUCTION TODAY: zero credits exist, and no code path could write
-- 'refunded' before this migration, so no row changes meaning.

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
             and fc.status not in ('void', 'refunded')
         ), 0);
$$;

revoke all     on function public.registration_available_cents(uuid, integer) from public;
revoke execute on function public.registration_available_cents(uuid, integer) from anon;
revoke execute on function public.registration_available_cents(uuid, integer) from authenticated;
grant  execute on function public.registration_available_cents(uuid, integer) to service_role;

comment on function public.registration_available_cents(uuid, integer) is
  'THE ceiling for a registration: paid, less refunds that are reserved-or-real, less credits that are neither void nor already paid back. The single implementation - reserve_refund_slot, issue_family_credit and refund-registration all read it. p_paid_cents comes from the caller because only it can read the real charged total from Stripe.';

-- The same correction in the payment_status rule, for the same reason: the
-- refundable base is what the family paid less what is still held as credit. A
-- credit that has been paid back is not still held.
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
      and status not in ('void', 'refunded')
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

comment on function public.registration_payment_status_after_refund(uuid, integer) is
  'The ONE payment_status rule for a refunded registration: refunded when everything refundable (paid, less credits still held) has gone back, partial when some has, NULL when none has so the caller leaves the status alone. Deliberately ignores held/in-flight money, which must not promote a status.';

-- ---------------------------------------------------------------------------
-- 2. SETTLE ONE CREDIT
-- ---------------------------------------------------------------------------
-- CALLABLE BY THE OPERATOR DIRECTLY, not through an edge function, and that is
-- deliberate: there is no Stripe call and no email here, only a status and a
-- ledger line. An edge function would add a deploy-order contract and a second
-- place to authorise, for nothing. So it proves the money bar ITSELF, the same
-- shape program_message_recipients uses.
--
-- WHY IT TAKES THE REGISTRATION LOCK. Settling changes the ceiling, and
-- reserve_refund_slot and issue_family_credit both read that ceiling under this
-- exact key. Without the lock, an operator voiding a credit while a refund is
-- being reserved could let both through and over-refund the registration.
--
-- ONLY AN ACTIVE CREDIT CAN BE SETTLED, re-read under the lock. Two operators
-- on the same credit, or a double-click, must not write two movement rows for
-- one event - the ledger would then say the family was paid back twice.
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
  v_org    uuid;
  v_status text;
  v_amt    integer;
  v_reg    uuid;
  v_kind   text;
  v_role   text;
begin
  -- 'spent' is NOT settleable here. It is written by the checkout path when a
  -- credit is applied, and unwinding that means putting the money back on a
  -- registration, which is a different job with a different ledger line.
  if p_new_status is null or p_new_status not in ('void', 'refunded') then
    raise exception 'settle_family_credit: % is not a status this function can set; use void or refunded', coalesce(p_new_status, 'null')
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

  -- AUTHZ. Read the JWT role defensively - a failure to PARSE a claim must never
  -- become a failure to AUTHORISE. service_role is the edge functions, which
  -- authorise their own callers before they get here.
  begin
    v_role := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '');
  exception when others then
    v_role := '';
  end;

  if v_role <> 'service_role' then
    if auth.uid() is null
       or not (can_handle_money(v_org) or is_platform_admin()) then
      raise exception 'settle_family_credit: not authorised for organisation %', v_org
        using errcode = 'FC008';
    end if;
  end if;

  -- Same lock key every other credit writer uses. Falls back to the credit's own
  -- id when the credit is not tied to a registration, so two settles of one
  -- credit still serialise.
  perform pg_advisory_xact_lock(
    hashtext('family_credit:' || coalesce(v_reg::text, p_credit_id::text))
  );

  -- RE-READ UNDER THE LOCK. The status above was read before it.
  select fc.status into v_status
  from public.family_credits fc
  where fc.id = p_credit_id;

  if v_status <> 'active' then
    raise exception 'settle_family_credit: credit % is already %; only an active credit can be settled', p_credit_id, v_status
      using errcode = 'FC009';
  end if;

  update public.family_credits
     set status = p_new_status,
         updated_at = now()
   where id = p_credit_id;

  v_kind := case when p_new_status = 'refunded' then 'refunded' else 'adjusted' end;

  -- registration_id stays NULL: the movements table reserves it for 'applied'
  -- rows, and the credit itself already carries source_registration_id.
  insert into public.family_credit_movements (
    credit_id, organization_id, amount_cents, kind, registration_id, note
  )
  values (
    p_credit_id, v_org, v_amt, v_kind, null, p_note
  );

  credit_id := p_credit_id; status := p_new_status; amount_cents := v_amt;
  return next;
end;
$$;

-- GRANTS, revoked BY NAME first. Production carries an ALTER DEFAULT PRIVILEGES
-- rule that hands EXECUTE on new functions to anon, which is how a definer
-- function became anon-reachable once before. `authenticated` is granted on
-- purpose here - the operator screen calls this directly - and the function
-- proves the money bar itself before it writes anything.
revoke all     on function public.settle_family_credit(uuid, text, text) from public;
revoke execute on function public.settle_family_credit(uuid, text, text) from anon;
grant  execute on function public.settle_family_credit(uuid, text, text) to authenticated;
grant  execute on function public.settle_family_credit(uuid, text, text) to service_role;

comment on function public.settle_family_credit(uuid, text, text) is
  'Ends one active credit: void (issued in error) or refunded (the family took the money instead). Takes the shared registration lock, re-reads the status under it, flips the credit and writes one family_credit_movements line - adjusted for a void, refunded for a cash out. Proves can_handle_money itself because the operator screen calls it directly. FC006 no such credit, FC007 bad target status, FC008 not authorised, FC009 credit is not active.';
