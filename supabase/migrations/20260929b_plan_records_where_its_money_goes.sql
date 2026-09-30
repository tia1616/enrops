-- Record, on the payment plan itself, which connected account its money goes
-- to - so an operator can change how they take payments without stranding the
-- plans a family has already authorised.
--
-- THE PROBLEM THIS CLOSES. A destination plan's charges 2 and 3 are routed by
-- process-installments using the org's CURRENT stripe_account_id, because
-- nothing records the account charge 1 actually transferred to. Two ways that
-- goes wrong:
--
--   1. An org that disconnects and reconnects a DIFFERENT Stripe account has
--      its in-flight plans silently start transferring to the new account.
--      That is wrong today, with no flip involved and nothing to warn anybody.
--
--   2. An org moving to direct charges gets a BRAND NEW connected account
--      (controller.fees.payer cannot be changed on an existing one), so every
--      plan started before the switch hits the fail-closed guard in
--      process-installments, is paused rather than charged, and raises an
--      operator alert. On prod that is 163 rows, 132 families and $27,728.72
--      running to 2027-04-01 - and the tail grows, because 40 new plans were
--      started in September alone.
--
-- Both are the same missing fact: the plan knows the amount and the card, but
-- not the destination. Recording it lets the plan finish exactly as agreed
-- while the org's own configuration moves on.
--
-- WHY A SNAPSHOT RATHER THAN A BLOCK. Identical reasoning to
-- 20260810f_fee_snapshot_on_installments, which froze fee_pass_through for the
-- same class of problem: a block cannot tell "this plan predates the switch and
-- is fine" apart from "this plan predates the switch and we have no idea where
-- its money should go", so it traps the operator until every plan finishes.
-- Recording the decision removes the ambiguity instead of warning about it.
--
-- SCOPE. Destination plans only. A DIRECT plan already records its account in
-- installments.stripe_charge_account_id, which is the account the charge was
-- created ON; this column is the account a platform charge transfers TO. They
-- are different facts and deliberately do not share a column - collapsing them
-- is what made null mean two things in the first place.
--
-- NULL means "not recorded" and falls back to exactly today's behaviour, so
-- rows written by an older deploy keep working unchanged.
--
-- THAT TOLERANCE IS FOR READERS ONLY. create-checkout and stripe-webhook both
-- name this column in their inserts, so code-before-migration means PostgREST
-- rejects the write as an unknown column: in create-checkout that expires the
-- session and every instalment checkout 500s, and in stripe-webhook it fails
-- AFTER charge 1 has been taken, leaving the plan unqueued with only an
-- operator alert as evidence.
--
-- So the order is not free: THIS MIGRATION MUST BE APPLIED TO BOTH
-- ENVIRONMENTS BEFORE EITHER WRITER IS DEPLOYED.

alter table public.checkout_schedules
  add column if not exists stripe_transfer_destination_id text;

alter table public.installments
  add column if not exists stripe_transfer_destination_id text;

comment on column public.checkout_schedules.stripe_transfer_destination_id is
  'For a DESTINATION charge, the connected account transfer_data.destination named when this checkout was created - read off the params actually sent to Stripe, never re-derived. NULL for a direct charge (the account is recorded as stripe_charge_account_id instead) and for an org with no connected account. Copied onto the installments rows by stripe-webhook.';

comment on column public.installments.stripe_transfer_destination_id is
  'Where THIS plan''s money goes, frozen at checkout - not wherever the org points today. process-installments routes charges 2 and 3 by this, so an operator changing their Stripe setup cannot redirect or strand a plan a family already authorised. NULL = not recorded; falls back to the org''s current account, i.e. the old behaviour.';

-- BACKFILL - and note carefully that this changes NO charge that happens today.
-- It stamps each still-chargeable destination row with the account
-- process-installments would have read from live org config on its next run
-- anyway, so the money moves to exactly the same place either way. All it does
-- is stop a LATER change of the org's account or charge model from moving it.
--
-- Only rows that can still be charged. A paid row is history and is never
-- re-charged, so writing a snapshot onto it would invent a record of a routing
-- decision we did not actually observe; NULL there stays honest. Rows paused
-- because the PROGRAM was cancelled are not chargeable either and are left
-- alone for the same reason.
--
-- Deliberately NOT backfilled, because we would be guessing rather than
-- recording: a platform row whose org is ALREADY on direct charges. That is
-- precisely the state the fail-closed guard exists for - the account the org
-- points at now is a different account from the one that plan settled against,
-- so stamping it would send a family's money somewhere it has never been. Those
-- rows keep hitting the guard and keep asking a human, which is correct.
--
-- Live at the time of writing (2026-09-29). PROD: j2s is the only org in scope,
-- 163 pending rows, and there are ZERO rows in the guess-required state above.
-- STAGING: j2s, 4 pending rows, likewise none ambiguous. The other orgs holding
-- pending rows (the-ukulele-project 102, branching-minds 10, staging's
-- onboard-test 3) are all on direct charges and already carry their account, so
-- this touches none of them.
update public.installments i
   set stripe_transfer_destination_id = o.stripe_account_id
  from public.organizations o
 where o.id = i.organization_id
   and i.stripe_transfer_destination_id is null
   and i.stripe_charge_account_id is null
   and o.stripe_account_id is not null
   and o.stripe_charge_model is distinct from 'direct'
   and i.status in ('pending', 'paused_card_failed');
