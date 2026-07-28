-- 20260728a — a Stripe refund can cover MORE THAN ONE registration.
--
-- WHY. Until now every refunds row was created by refund-registration, which
-- issues one Stripe refund per (registration, PaymentIntent) slot, so one
-- Stripe refund id only ever mapped to one registration and a global UNIQUE
-- held fine.
--
-- Arielle's v4 section 3 breaks that assumption. An operator with a full Stripe
-- dashboard can refund the CHARGE directly in Stripe, and a single charge
-- routinely covers several registrations — a multi-child cart, or an aggregated
-- installment charge. stripe-webhook has to record that one Stripe refund
-- against each registration it actually paid for, which the global UNIQUE makes
-- impossible: the second row would fail with 23505 and that child's refund
-- would silently never be recorded.
--
-- SAFETY. This only LOOSENS the constraint, so no existing row can violate the
-- replacement. At the time of writing: prod has 0 refunds rows, staging has 1.
-- Per-registration uniqueness is still exactly what the webhook needs to be
-- idempotent — replaying the same charge.refunded event finds the existing
-- (refund, registration) row and does nothing.

ALTER TABLE public.refunds
  DROP CONSTRAINT IF EXISTS refunds_stripe_refund_id_key;

ALTER TABLE public.refunds
  ADD CONSTRAINT refunds_stripe_refund_id_registration_id_key
  UNIQUE (stripe_refund_id, registration_id);

COMMENT ON CONSTRAINT refunds_stripe_refund_id_registration_id_key ON public.refunds IS
  'One row per (Stripe refund, registration). A refund issued in the operator''s own Stripe dashboard covers the whole charge, which may span several registrations; each gets its own row. Also the idempotency key for stripe-webhook''s charge.refunded handler.';
