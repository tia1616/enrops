-- 20260528_instructor_payouts.sql
--
-- Schema for the Run Payroll build (instructor pay via Stripe Connect).
-- Spec: see chat handoff 2026-05-28.
--
-- Adds:
--   1. instructor_payouts table (one row per transfer attempt; mirrors the
--      refunds table pattern).
--   2. Extends session_delivery_confirmations.pay_status enum to include
--      'paid', plus a FK column linking each settled confirmation to its
--      payout row.
--   3. Distance bonus paid-marker columns on camp_assignments (distance
--      bonus is paid once per assignment, not per session).
--   4. instructor_pay_enabled circuit-breaker column on organizations. No
--      tenant ID hardcoded in code; the feature is gated per-org via this
--      boolean. Today only J2S is enabled (seeded in
--      supabase/seeds/j2s_bootstrap.sql).
--   5. Unique partial index on (instructor_id, camp_session_id) for
--      in-flight payouts to prevent the double-pay race condition (two
--      concurrent Pay clicks each insert a pending row; the second one
--      fails with the unique constraint and returns 409 instead of
--      issuing a duplicate Stripe transfer).
--
-- Pay-line model: session_delivery_confirmations IS the pay line. Actions
-- (approve / withhold / mark paid) operate per row. UI groups for display
-- but actions are per row. This sets up clean integration with the
-- assignment_substitutions table when the FA26 substitutions work ships:
-- the effective-instructor resolver does a LEFT JOIN against that table
-- and routes pay to the sub when one exists; today the resolver
-- gracefully returns the regular instructor.

-- ──────────────────────────────────────────────────────────────────────
-- (1) instructor_payouts: one row per payout attempt
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS instructor_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  -- The EFFECTIVE instructor (sub or regular, resolved at pay time).
  instructor_id UUID NOT NULL REFERENCES instructors(id) ON DELETE RESTRICT,
  camp_session_id UUID NOT NULL REFERENCES camp_sessions(id) ON DELETE RESTRICT,
  -- Stripe destination = the effective instructor's Connect Express acct,
  -- snapshotted at pay time in case the linked row changes later.
  stripe_destination_account_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  -- Snapshot of which session_delivery_confirmations were settled. Array
  -- so a single payout can cover multiple days at once. Not a FK because
  -- arrays can't be FKs in Postgres; integrity enforced by the function.
  session_confirmation_ids UUID[] NOT NULL,
  includes_distance_bonus BOOLEAN NOT NULL DEFAULT false,
  -- Stripe transfer artifact (NULL until succeeded, or never set when via_stripe=false).
  stripe_transfer_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed')),
  failure_reason TEXT,
  -- Who triggered. NULL on user-deleted (audit trail by deletion is a
  -- separate problem).
  paid_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- via_stripe=false means operator paid outside Enrops (Stripe dashboard,
  -- Gusto, manual transfer, check, etc.) and is just recording it here.
  via_stripe BOOLEAN NOT NULL DEFAULT true,
  manual_payment_note TEXT,  -- required when via_stripe=false (enforced in fn)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  succeeded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_instructor_payouts_instructor ON instructor_payouts(instructor_id);
CREATE INDEX IF NOT EXISTS idx_instructor_payouts_org ON instructor_payouts(organization_id);
CREATE INDEX IF NOT EXISTS idx_instructor_payouts_camp ON instructor_payouts(camp_session_id);
CREATE INDEX IF NOT EXISTS idx_instructor_payouts_stripe_transfer ON instructor_payouts(stripe_transfer_id) WHERE stripe_transfer_id IS NOT NULL;

-- The double-pay defense. Only ONE in-flight (or succeeded-but-not-reversed)
-- payout can exist per (instructor, camp_session) tuple. A reversal flips
-- the row to 'failed', freeing the slot for a fresh attempt.
CREATE UNIQUE INDEX IF NOT EXISTS uq_instructor_payouts_no_concurrent
  ON instructor_payouts(instructor_id, camp_session_id)
  WHERE status IN ('pending', 'succeeded');

COMMENT ON TABLE  instructor_payouts IS 'One row per instructor pay attempt. Either a Stripe Connect transfer (via_stripe=true) or a manual record-keeping entry (via_stripe=false).';
COMMENT ON COLUMN instructor_payouts.instructor_id IS 'The EFFECTIVE instructor being paid (sub or regular per the resolver). NOT necessarily camp_assignments.instructor_id.';
COMMENT ON COLUMN instructor_payouts.stripe_destination_account_id IS 'Snapshot of the instructor''s stripe_connect_account_id at pay time. Defensive against later DB changes.';
COMMENT ON COLUMN instructor_payouts.session_confirmation_ids IS 'IDs of the session_delivery_confirmations this payout settled. Array (not FK) — operational integrity, not referential.';
COMMENT ON COLUMN instructor_payouts.via_stripe IS 'true = Stripe Connect transfer attempted. false = operator paid outside Enrops; this row is record-keeping only.';
COMMENT ON COLUMN instructor_payouts.manual_payment_note IS 'Required when via_stripe=false. Operator note: "Paid via Gusto May 30," transfer ID from Stripe dashboard, "Check #1234," etc.';

ALTER TABLE instructor_payouts ENABLE ROW LEVEL SECURITY;

-- Org members can read+write their org's payouts. Owner/admin gating is
-- enforced in the edge function (where role lookup is cleaner). RLS is the
-- defense-in-depth layer.
CREATE POLICY org_members_manage_instructor_payouts ON instructor_payouts
  FOR ALL
  USING (is_org_member(organization_id) OR is_platform_admin())
  WITH CHECK (is_org_member(organization_id) OR is_platform_admin());

-- Instructors see their own payouts. Useful for an instructor-portal
-- "Pay history" view (future).
CREATE POLICY instructors_see_own_payouts ON instructor_payouts
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM instructors i
      WHERE i.id = instructor_payouts.instructor_id
        AND i.auth_user_id = auth.uid()
    )
  );

-- ──────────────────────────────────────────────────────────────────────
-- (2) session_delivery_confirmations: extend pay_status + payout link
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE session_delivery_confirmations
  DROP CONSTRAINT IF EXISTS session_delivery_confirmations_pay_status_check;

ALTER TABLE session_delivery_confirmations
  ADD CONSTRAINT session_delivery_confirmations_pay_status_check
  CHECK (pay_status IN ('pending', 'approved', 'adjusted', 'withheld', 'paid'));

ALTER TABLE session_delivery_confirmations
  ADD COLUMN IF NOT EXISTS instructor_payout_id UUID REFERENCES instructor_payouts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_session_confirmations_payout ON session_delivery_confirmations(instructor_payout_id) WHERE instructor_payout_id IS NOT NULL;

COMMENT ON COLUMN session_delivery_confirmations.instructor_payout_id IS 'When non-NULL, this confirmation has been settled by the linked payout. The canonical "paid" artifact (do not gate on pay_status=''paid'' alone — that''s a display label).';

-- ──────────────────────────────────────────────────────────────────────
-- (3) camp_assignments: distance bonus paid-marker
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE camp_assignments
  ADD COLUMN IF NOT EXISTS distance_bonus_paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS distance_bonus_payout_id UUID REFERENCES instructor_payouts(id) ON DELETE SET NULL;

COMMENT ON COLUMN camp_assignments.distance_bonus_paid_at IS 'When non-NULL, the distance bonus for this assignment was settled by the linked payout. NULL = unpaid (eligible to be included in a future payout when the regular instructor has at least one approved session they themselves taught).';

-- ──────────────────────────────────────────────────────────────────────
-- (4) organizations: instructor_pay circuit breaker
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS instructor_pay_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN organizations.instructor_pay_enabled IS 'Circuit breaker for instructor pay via integrated Stripe Connect transfers. Must be explicitly enabled per-tenant after their instructor-pay Stripe platform is set up. Today only J2S is enabled (the shared STRIPE_INSTRUCTOR_PLATFORM_KEY env var points to J2S''s platform). Future: when multi-tenant instructor pay ships, per-tenant platform config is required before flipping this. Manual "Mark paid" path is always available regardless of this flag — only the integrated Stripe path is gated.';
