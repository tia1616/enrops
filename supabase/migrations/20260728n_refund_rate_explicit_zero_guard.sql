-- Restore the explicit zero guard that migration 20260728m dropped.
--
-- THE BUG. Migration m folded the previous implementation's explicit
--   IF v_txn IS NULL OR v_txn < v_min_txn OR v_txn = 0 THEN RETURN false; END IF;
-- into a single boolean expression:
--   (v_txn >= v_min_txn AND v_txn > 0 AND ((v_ref::numeric * 100) / v_txn) >= v_threshold)
-- That leaves the division protected only by the ORDER of the AND operands, and
-- PostgreSQL explicitly does not guarantee that AND is evaluated left to right.
-- The rate column one line above got this right with a CASE; the flagged column
-- did not, purely because it was written as one expression.
--
-- IS IT REACHABLE? v_txn = 0 is not exotic. The txn CTE counts only charges
-- INSIDE the rolling window, so an operator refunding a registration that was
-- paid more than window_days ago has a refund row and zero transactions. On
-- today's planner the expression short-circuits and returns false, which is why
-- this never fired in testing. That is luck, not a guarantee, and the cost of
-- being wrong is a division_by_zero raised inside operator_refund_rate, which
-- propagates through is_operator_refund_flagged into maybeSendOperatorGrowthAsk
-- on the refund path.
--
-- Guard explicitly. Nothing else about the function changes, and the returned
-- shape is byte-identical for every input that previously worked.

CREATE OR REPLACE FUNCTION public.operator_refund_rate(p_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cfg jsonb; v_days integer; v_threshold numeric; v_min_txn integer;
  v_since timestamptz; v_txn bigint; v_ref bigint; v_rate numeric; v_flagged boolean;
BEGIN
  SELECT ps.value INTO v_cfg FROM platform_settings ps WHERE ps.key = 'refund_watch';
  v_cfg       := COALESCE(v_cfg, '{}'::jsonb);
  v_days      := COALESCE((v_cfg->>'window_days')::int, 30);
  v_threshold := COALESCE((v_cfg->>'rate_threshold_pct')::numeric, 15);
  v_min_txn   := COALESCE((v_cfg->>'min_transactions')::int, 5);
  v_since     := now() - make_interval(days => v_days);

  WITH txn AS (
    SELECT i.stripe_payment_intent_id AS pi
    FROM installments i
    WHERE i.organization_id = p_org AND i.status = 'paid'
      AND i.paid_at >= v_since AND i.stripe_payment_intent_id IS NOT NULL
    GROUP BY i.stripe_payment_intent_id
    UNION
    -- A registration paid in one go has no installment row. Leaving this leg out
    -- shrinks the denominator and inflates the rate, which is how an operator
    -- gets flagged for nothing.
    SELECT r.stripe_payment_intent_id
    FROM registrations r
    WHERE r.organization_id = p_org AND r.stripe_payment_intent_id IS NOT NULL
      AND r.payment_status IN ('paid','partial','refunded') AND r.registered_at >= v_since
      AND NOT EXISTS (SELECT 1 FROM installments i2 WHERE i2.registration_id = r.id)
    GROUP BY r.stripe_payment_intent_id
  )
  SELECT
    (SELECT COUNT(*) FROM txn),
    -- Refunded CHARGES, not refund events. Two partial refunds against one
    -- charge is one refunded charge; counting events produced a 225% rate.
    (SELECT COUNT(DISTINCT rf.stripe_payment_intent_id)
       FROM refunds rf
      WHERE rf.organization_id = p_org AND rf.status = 'succeeded'
        AND rf.succeeded_at >= v_since
        AND rf.stripe_payment_intent_id IN (SELECT pi FROM txn))
  INTO v_txn, v_ref;

  v_txn := COALESCE(v_txn, 0);
  v_ref := COALESCE(v_ref, 0);

  -- The guard, stated once, before anything divides by v_txn.
  IF v_txn = 0 THEN
    v_rate := 0;
    v_flagged := false;
  ELSE
    v_rate := ROUND((v_ref::numeric * 100) / v_txn, 1);
    v_flagged := (v_txn >= v_min_txn AND ((v_ref::numeric * 100) / v_txn) >= v_threshold);
  END IF;

  RETURN jsonb_build_object(
    'transactions',       v_txn,
    'refunded',           v_ref,
    'rate_pct',           v_rate,
    'window_days',        v_days,
    'rate_threshold_pct', v_threshold,
    'min_transactions',   v_min_txn,
    'flagged',            v_flagged
  );
END
$$;

-- CREATE OR REPLACE preserves grants, but this function is the one an operator
-- must never be able to call, so re-assert rather than assume.
REVOKE ALL ON FUNCTION public.operator_refund_rate(uuid) FROM public;
REVOKE ALL ON FUNCTION public.operator_refund_rate(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.operator_refund_rate(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.operator_refund_rate(uuid) TO service_role;
