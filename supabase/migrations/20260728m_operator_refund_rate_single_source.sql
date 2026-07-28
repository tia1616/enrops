-- One formula for the refund rate, read by everything that reports it.
--
-- THE BUG THIS FIXES. is_operator_refund_flagged() computed the rate one way,
-- and the alert email computed it again in TypeScript a slightly different way
-- (installments only, no registrations-without-installments leg). So the alert
-- could say "2 of 2 charges, 100%" about a crossing the database had decided on
-- a denominator of 6. A number in an email that disagrees with the number on the
-- screen it links to is worse than no number: it makes someone distrust both.
--
-- Caught on staging before it shipped, when j2s flagged at a transaction count
-- the TypeScript said was below the minimum.
--
-- THE RULE, restated: whoever computes a reported number computes it ONCE, and
-- every other reader calls that. is_operator_refund_flagged now delegates here
-- rather than carrying a second copy of the arithmetic.
--
-- get_operator_refund_rates() (the Refund Watch list) keeps its own set-returning
-- query because it aggregates every org in one pass. That is a third copy of the
-- shape and it is a known, accepted risk, mitigated by the note at the bottom of
-- this file rather than by an assert that cannot run here.

CREATE OR REPLACE FUNCTION public.operator_refund_rate(p_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cfg jsonb; v_days integer; v_threshold numeric; v_min_txn integer;
  v_since timestamptz; v_txn bigint; v_ref bigint; v_rate numeric;
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
  v_rate := CASE WHEN v_txn = 0 THEN 0 ELSE ROUND((v_ref::numeric * 100) / v_txn, 1) END;

  RETURN jsonb_build_object(
    'transactions',       v_txn,
    'refunded',           v_ref,
    'rate_pct',           v_rate,
    'window_days',        v_days,
    'rate_threshold_pct', v_threshold,
    'min_transactions',   v_min_txn,
    'flagged',            (v_txn >= v_min_txn AND v_txn > 0 AND ((v_ref::numeric * 100) / v_txn) >= v_threshold)
  );
END
$$;

COMMENT ON FUNCTION public.operator_refund_rate(uuid) IS
  'Canonical refund-rate calculation for one org (v4 section 4). is_operator_refund_flagged and the alert email both read this so a flag and the email about it can never disagree.';

-- Not exposed to operators: an operator must never be able to see whether they
-- are flagged, and the raw counts would tell them.
REVOKE ALL ON FUNCTION public.operator_refund_rate(uuid) FROM public;
REVOKE ALL ON FUNCTION public.operator_refund_rate(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.operator_refund_rate(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.operator_refund_rate(uuid) TO service_role;

-- Now the flag is a thin read of the same object, not a second implementation.
CREATE OR REPLACE FUNCTION public.is_operator_refund_flagged(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((public.operator_refund_rate(p_org) ->> 'flagged')::boolean, false);
$$;

COMMENT ON FUNCTION public.is_operator_refund_flagged(uuid) IS
  'True when this org is over the refund-rate threshold. Delegates to operator_refund_rate so there is exactly one formula. Never gates a refund.';

-- NOT ASSERTED HERE, ON PURPOSE. The obvious check would be to compare this
-- against get_operator_refund_rates(), but that function is platform-admin gated
-- and a migration runs without a JWT, so any in-migration version of the check
-- would either be skipped or, worse, be written to compare this function against
-- itself and pass while proving nothing. The two were compared row by row on
-- staging when this landed and agreed for every org in the window. If the list
-- query is ever edited, re-run that comparison rather than trusting this note.
