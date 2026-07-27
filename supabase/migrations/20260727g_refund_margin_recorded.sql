-- 20260727g — record how much platform margin went back on each refund.
--
-- On a destination charge the application fee is deliberately larger than
-- Enrops's margin: it is margin + an estimate of Stripe's processing fee,
-- whenever the provider bears that fee. On a refund the two halves are treated
-- differently (Jessica's decision, 2026-07-25, superseding "Enrops absorbs it"):
--
--   the MARGIN half goes back  - Enrops earned nothing on a cancelled
--     registration.
--   the STRIPE-FEE half does NOT - Stripe keeps its processing fee on a refund,
--     so handing that half back means Enrops pays Stripe out of its own pocket
--     every time an operator refunds a family.
--
-- Because that is a partial application-fee refund rather than the all-or-
-- nothing refund_application_fee boolean, the amount is computed per refund
-- (see _shared/refundFeeSplit.ts) and issued as its own
-- applicationFees.createRefund call. This column stores what was actually
-- returned so the split is auditable after the fact rather than having to be
-- re-derived from Stripe.
--
-- NULL means "not applicable or not recorded": every refund that predates this
-- (there are none in prod as of 2026-07-27 - the refunds table is empty), any
-- direct charge (where refund_application_fee:true returns the whole fee and
-- there is no split to record), and any legacy own-platform org that never
-- carried an uplift. Additive and nullable, so nothing existing changes.

ALTER TABLE public.refunds
  ADD COLUMN IF NOT EXISTS platform_fee_refunded_cents integer;

COMMENT ON COLUMN public.refunds.platform_fee_refunded_cents IS
  'Cents of the Stripe application fee returned to the operator on this refund - the MARGIN half only, never the Stripe-fee half, which Stripe does not give back. NULL = not applicable (direct charge, no uplift) or not recorded.';
