-- Snapshot the fee decision onto a payment plan, so flipping fee_pass_through
-- can never reprice instalments a family already authorised.
--
-- THE PROBLEM THIS CLOSES. process-installments recomputed the pass-through fee
-- from LIVE org config on every off-session charge, and nothing recorded what
-- the family agreed to - checkout_schedules and installments.amount_cents hold
-- base amounts only. So with a plan running, turning pass-through ON charged a
-- saved card MORE than the family authorised, with no fee line, no fresh
-- consent, and a confirmation email still quoting the old figure. That email is
-- the family's only artefact of the schedule they agreed to, so it is what a
-- chargeback is judged against.
--
-- It became reachable on 2026-08-06: before then only platform admins could
-- change fee_pass_through; now every owner/admin can.
--
-- WHY A SNAPSHOT RATHER THAN A BLOCK. A block cannot tell "newly imposing a
-- fee" apart from "restoring one those families already authorised" - that is
-- precisely the snapshot we lacked - so it would trap an operator who
-- mis-clicked until every plan finished. Recording the decision removes the
-- consent problem instead of warning about it, which is also what other
-- platforms do: Stripe prices are immutable and existing subscribers stay on
-- the price they agreed to, and TeamSnap makes the registrant re-confirm when
-- an admin edits instalment terms after the fact.
--
-- NULL means "not recorded" and falls back to live org config, i.e. exactly
-- today's behaviour. That is what makes the code side deployable in either
-- order: rows written by an older deploy keep working unchanged.

alter table public.checkout_schedules
  add column if not exists fee_pass_through boolean;

alter table public.installments
  add column if not exists fee_pass_through boolean;

comment on column public.checkout_schedules.fee_pass_through is
  'The org''s fee_pass_through at the moment this checkout was created. Copied onto the installments rows by stripe-webhook. NULL = not recorded (older row); readers fall back to live org config.';

comment on column public.installments.fee_pass_through is
  'What the FAMILY agreed to, frozen at checkout - not the org''s current setting. process-installments honours this over live config, so flipping the toggle only affects NEW registrations. NULL = not recorded; falls back to live config.';

-- BACKFILL - and note carefully that this changes NO charge that happens today.
-- It stamps each still-chargeable row with the value process-installments would
-- have read from live config on its next run anyway, so the amount charged is
-- identical either way. All it does is stop a LATER flip from moving it.
--
-- Only rows that can still be charged. A paid row is history and is never
-- re-charged, so writing a snapshot onto it would be inventing a record of a
-- decision we did not actually observe; NULL there stays honest.
--
-- Live prod at the time of writing (2026-08-10): j2s absorbs the fee and has 42
-- pending rows across 33 families running to 2027-04-01; the-ukulele-project
-- passes it through and has 4 pending across 2 families. No fee_pass_through
-- change has ever been recorded in organization_money_audit, so the current
-- value is the value those families registered under.
update public.installments i
   set fee_pass_through = o.fee_pass_through
  from public.organizations o
 where o.id = i.organization_id
   and i.fee_pass_through is null
   and i.status in ('pending', 'paused_card_failed');
