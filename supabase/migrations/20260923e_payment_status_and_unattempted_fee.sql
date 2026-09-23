-- Two review findings, both about what is left behind when a refund request dies.
--
-- ---------------------------------------------------------------------------
-- 1. ONE payment_status RULE, AND IT KNOWS ABOUT CREDITS
-- ---------------------------------------------------------------------------
-- The rule was written twice - once in refund-registration and once in
-- stripe-webhook - and both spelled it `refunded >= paid`, with no credits
-- subtracted. So a registration settled by a MIX of refund and credit could
-- never reach 'refunded': $240 paid, $120 credited, $120 refunded leaves
-- nothing refundable and still reads 'partial', permanently, implying there is
-- more to come back.
--
-- Fixing that in one copy would have recreated the divergence this whole series
-- has been removing, so it becomes one function both callers read.
--
-- THE SENTENCE THE RULE ENCODES: "has everything that COULD be refunded been
-- refunded?" The refundable base is what the family paid, less what has been
-- turned into credit - because a credited dollar is no longer a refundable one.
--
-- WHAT IT DELIBERATELY DOES NOT DO:
--   * It does not use `registration_available_cents`. That figure also
--     subtracts money merely HELD - a reservation in flight, or a refund Stripe
--     never answered on - and a registration is not "refunded" because a
--     payment is temporarily pending. Holds must not promote the status.
--   * It returns NULL when nothing has been refunded, so the caller leaves
--     payment_status alone. A credit on its own does not make a registration
--     'refunded' or 'partial': no money went back to the card, the business
--     still holds it, and the liability lives in family_credits.
--
-- WHY 'refunded' AND NOT A NEW STATUS. Nothing branches on 'partial' vs
-- 'refunded' - the readers all key on 'paid' (rosters, enrolment counts, the
-- delete guard), and get_revenue_summary counts all three as captured. So this
-- changes what an operator READS, not what the platform DOES. Jessica should
-- overrule if she reads 'refunded' as "every dollar went back to the card"
-- rather than "there is nothing left to get back".

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
      and status <> 'void'
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
  'The ONE payment_status rule for a refunded registration: refunded when everything refundable (paid, less non-void credits) has gone back, partial when some has, NULL when none has so the caller leaves the status alone. Deliberately ignores held/in-flight money, which must not promote a status.';

-- ---------------------------------------------------------------------------
-- 2. A FEE RETURN THAT WAS NEVER ATTEMPTED MUST NOT LOOK LIKE ONE THAT WAS
-- ---------------------------------------------------------------------------
-- When a refund request dies between creating the Stripe refund and returning
-- the application fee - the ambiguous-timeout path - the row ends with
-- platform_fee_refunded_cents and fee_return_outcome both NULL. The webhook can
-- confirm the refund happened, but it cannot know whether the fee came back,
-- and NULL is indistinguishable from "no fee was ever owed". The Finances tab
-- renders a warning for 'failed' and a grey note for 'nothing_owed', and
-- nothing at all for NULL - so the provider's margin quietly never returns and
-- the row reads as a clean, complete refund.
--
-- That is the shape that hid the three 8 September failures, and this series
-- introduced a new way to produce it.
--
-- 'failed' would be a lie: nothing was tried. 'not_attempted' is the honest
-- fourth state, and it is what the operator surface and the shortfall alert key
-- on to say a human still has to return this one.
alter table public.refunds
  drop constraint if exists refunds_fee_return_outcome_check;

alter table public.refunds
  add constraint refunds_fee_return_outcome_check
  check (
    fee_return_outcome is null
    or fee_return_outcome = any (array['returned'::text, 'nothing_owed'::text, 'failed'::text, 'not_attempted'::text])
  );
