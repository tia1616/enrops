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
--
-- AND A ROLLBACK RUNS THE SAME CONTRACT BACKWARDS. Dropping these columns while
-- create-checkout or stripe-webhook are still deployed reproduces the failure
-- exactly: PostgREST rejects the write as an unknown column, checkouts 500, and
-- the webhook fails AFTER charge 1 is taken. The columns must OUTLIVE the
-- functions in any revert. process-installments is safe in either direction -
-- it selects '*', so a missing column reads as undefined, which resolvePlanRouting
-- treats identically to the old unrecorded case.
--
-- RUN THE BACKFILL AGAIN AFTER THE WRITERS ARE DEPLOYED. Any plan whose charge 1
-- completes between this migration and the stripe-webhook deploy gets NULL on
-- every row, and the one-shot backfill below has already been and gone. Re-running
-- the same statement afterwards is idempotent (the `is null` guard means a row
-- already stamped is never touched) and closes that window.

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
-- Only rows that can still be charged, expressed as a DENY-list of the two
-- provably terminal states. 20260810f got this wrong with an allow-list of
-- ('pending','paused_card_failed') and 20260810g had to correct it: the CHECK
-- permits six statuses, and 'failed' and 'paused_program_cancelled' are NOT
-- terminal - process-installments' own alert tells operators to "flip the rows
-- back to status=pending to retry". A row resurrected that way would carry no
-- routing and strand the family on the next switch, which is the whole thing
-- this migration exists to prevent. On prod today that is 16 real rows worth
-- $2,681.36 sitting in paused_program_cancelled.
--
-- A paid row is history and is never re-charged, so writing a snapshot onto it
-- would invent a record of a routing decision we did not observe; NULL there
-- stays honest. A refunded row is closed.
--
-- stripe_charges_enabled is required because the claim has to be TRUE. With the
-- account disabled, buildConnectChargeParams returns no transfer_data at all,
-- so the charge would not go to this account and stamping it would record a
-- destination the money never took. Those rows stay NULL and keep asking a
-- human, which is the honest answer.
--
-- Deliberately NOT backfilled, because we would be guessing rather than
-- recording: a platform row whose org is ALREADY on direct charges. That is
-- precisely the state the fail-closed guard exists for - the account the org
-- points at now is a different account from the one that plan settled against,
-- so stamping it would send a family's money somewhere it has never been. Those
-- rows keep hitting the guard and keep asking a human, which is correct.
--
-- BLAST RADIUS, MEASURED 2026-09-30. Read the caveat before trusting the number.
--
-- PROD: j2s is the only org in scope, 178 rows -
--     161 pending
--    + 16 paused_program_cancelled  (admitted by the deny-list above)
--    +  1 paused_card_failed        (ditto - a card declined on 30 Sept)
-- and ZERO rows in the guess-required state, i.e. no platform-charge row on an
-- org already moved to direct.
--
-- STAGING: j2s, 4 rows. The orgs holding other non-terminal rows
-- (the-ukulele-project 110, branching-minds 10, staging's onboard-test 3) are
-- all on direct charges and already carry their account, so this touches none
-- of them.
--
-- HOW IT WAS COUNTED, because the obvious reading is wrong. This file's
-- predicate cannot be run against prod as written: prod has no
-- stripe_transfer_destination_id column until this migration creates it, so
-- `i.stripe_transfer_destination_id is null` has nothing to evaluate. The count
-- above was taken with that one clause omitted, which is equivalent on a
-- database that has never had the column - nothing can be recorded there - but
-- it is a reconstruction, not a run of this statement. Do not describe it as
-- one.
--
-- AND IT MOVES. This is a snapshot of live money, not an invariant. An earlier
-- draft of this note said 179, which was true on 29 Sept; overnight one row
-- charged and one declined, so pending fell to 161 and paused_card_failed rose
-- to 1. Re-count before applying rather than trusting any number written here -
-- what should stay constant is the SHAPE: one org in scope, and zero rows in
-- the guess-required state.
update public.installments i
   set stripe_transfer_destination_id = o.stripe_account_id
  from public.organizations o
 where o.id = i.organization_id
   and i.stripe_transfer_destination_id is null
   and i.stripe_charge_account_id is null
   and o.stripe_account_id is not null
   and o.stripe_charges_enabled
   and o.stripe_charge_model is distinct from 'direct'
   and coalesce(i.status, 'pending') not in ('paid', 'refunded');
