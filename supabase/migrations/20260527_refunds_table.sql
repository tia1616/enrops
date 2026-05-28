-- 20260527_refunds_table.sql
--
-- One row per refund event. Supports full, partial, and stacked partial
-- refunds against a single registration. Total refunded for a registration
-- is SUM(amount_cents) WHERE registration_id = X AND status = 'succeeded'.
--
-- Refund flow:
--   1. Operator clicks Refund on Rosters page -> drawer.
--   2. Frontend POSTs to refund-registration edge fn with
--      { registration_id, amount_cents, reason, cancel_registration }.
--   3. Edge fn:
--      a. Verifies caller is org owner/admin via org_members.
--      b. Inserts a refunds row with status='pending'.
--      c. Calls stripe.refunds.create({
--           payment_intent: ...,
--           amount: amount_cents,
--           refund_application_fee: false,   <- Enrops keeps the fee
--           reverse_transfer: true,          <- pulls back from operator
--           reason: 'requested_by_customer',
--           metadata: { enrops_refund_id, enrops_registration_id, reason },
--         })
--      c. On success: update refunds row with stripe_refund_id +
--         status='succeeded'. If cancel_registration: set registrations.
--         status='refunded', cancelled_at=now(), and cancel pending
--         installments (status='paused_program_cancelled' or similar).
--      d. On failure: update refunds row with status='failed' +
--         failure_reason.
--
-- The edge fn picks which PaymentIntent to refund against by ordering:
--   1. registrations.stripe_payment_intent_id (initial checkout charge)
--   2. installments rows where status='paid', oldest installment_number first
-- For shared-PI cases (sibling registrations in one cart), Stripe handles
-- partial refunds correctly; the eligible amount per registration is the
-- registration's amount_cents minus already-refunded.

CREATE TABLE IF NOT EXISTS refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id UUID NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  stripe_payment_intent_id TEXT NOT NULL,
  stripe_refund_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT,
  refunded_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelled_registration BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed')),
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  succeeded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_refunds_registration_id ON refunds(registration_id);
CREATE INDEX IF NOT EXISTS idx_refunds_organization_id ON refunds(organization_id);
CREATE INDEX IF NOT EXISTS idx_refunds_stripe_payment_intent_id ON refunds(stripe_payment_intent_id);

COMMENT ON TABLE  refunds IS 'One row per refund event. Multiple partial refunds against one registration stack as multiple rows. Total refunded = SUM(amount_cents) WHERE status=succeeded.';
COMMENT ON COLUMN refunds.stripe_payment_intent_id IS 'The PI being refunded against. For partial refunds we pick the most recently paid PI first.';
COMMENT ON COLUMN refunds.stripe_refund_id IS 'Stripe re_... ID. NULL until status flips to succeeded.';
COMMENT ON COLUMN refunds.reason IS 'Operator-supplied internal note. Not sent to parent; Stripe sends its own automatic refund email.';
COMMENT ON COLUMN refunds.cancelled_registration IS 'true = this refund also cancelled the registration and stopped future installments. Audit signal.';

-- RLS: org members read+write their own org's refunds; platform admins all.
-- Parents see refunds for their own registrations.
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;

CREATE POLICY members_manage_org_refunds ON refunds
  FOR ALL
  USING (is_org_member(organization_id) OR is_platform_admin())
  WITH CHECK (is_org_member(organization_id) OR is_platform_admin());

CREATE POLICY parents_see_own_refunds ON refunds
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM registrations r
      WHERE r.id = refunds.registration_id
        AND r.parent_id = current_parent_id()
    )
  );
