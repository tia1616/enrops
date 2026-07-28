-- 20260728b — Arielle's v4 section 4: abuse monitoring, FLAG don't block.
--
-- v4's wording is the whole design brief: "Set a threshold (e.g., 15%) that
-- flags the operator account for internal review. This never blocks or delays
-- any individual refund - it's a dashboard flag for us, not a gate on the
-- transaction." So nothing here is referenced by any refund code path. It is a
-- read-only lens for the platform team.
--
-- NOTE ON HISTORY: staging received this in several passes (20260728b..e) while
-- three defects were found against live data. This file is the reconciled FINAL
-- state and matches what is actually deployed on staging — verified by reading
-- the definitions back out of the database, not by trusting these drafts. Any
-- environment that has not run it yet needs only this file.
--
-- The three defects, all found by running against real rows:
--   1. "refunds / transactions" counted refund EVENTS against charges and
--      produced 225% on staging. One charge can be refunded in several slices.
--      The rate now counts CHARGES THAT WERE REFUNDED — bounded at 100% and the
--      standard payments definition.
--   2. Filtering registrations on payment_method='stripe' dropped every
--      'stripe_installments' row. On PROD that is 35 of the 69 registrations
--      holding a payment intent, i.e. half of production. The presence of a
--      payment intent is the evidence money moved; the label is not.
--   3. is_operator_refund_flagged was declared STABLE but created a TEMP TABLE.
--      Section 8 will call it per row, where DDL inside a read-only-declared
--      function is both wrong and slow. It is a plain CTE now.

-- ── 1. platform-wide settings ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.platform_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.platform_settings IS
  'Platform-wide (NOT per-tenant) configuration. Tenant config belongs on organizations.';

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

-- Every verb the screen implies gets its own policy. The row is read AND written
-- from the same page; a table with only SELECT would let the first save look
-- fine and every later one die 42501.
DROP POLICY IF EXISTS platform_settings_read ON public.platform_settings;
CREATE POLICY platform_settings_read ON public.platform_settings
  FOR SELECT USING (is_platform_admin());

DROP POLICY IF EXISTS platform_settings_insert ON public.platform_settings;
CREATE POLICY platform_settings_insert ON public.platform_settings
  FOR INSERT WITH CHECK (is_platform_admin());

DROP POLICY IF EXISTS platform_settings_update ON public.platform_settings;
CREATE POLICY platform_settings_update ON public.platform_settings
  FOR UPDATE USING (is_platform_admin()) WITH CHECK (is_platform_admin());

GRANT SELECT, INSERT, UPDATE ON public.platform_settings TO authenticated;

-- ON CONFLICT DO NOTHING so re-running never stomps a tuned threshold.
INSERT INTO public.platform_settings (key, value)
VALUES ('refund_watch', jsonb_build_object(
  'rate_threshold_pct', 15,
  'min_transactions',   5,
  'window_days',        30
))
ON CONFLICT (key) DO NOTHING;

-- ── 2. the rolling-window rate, per operator ────────────────────────────────
DROP FUNCTION IF EXISTS public.get_operator_refund_rates(integer);

CREATE OR REPLACE FUNCTION public.get_operator_refund_rates(p_days integer DEFAULT NULL)
RETURNS TABLE (
  organization_id    uuid,
  slug               text,
  name               text,
  transactions       bigint,
  refunds            bigint,
  refund_events      bigint,
  refund_rate_pct    numeric,
  collected_cents    bigint,
  refunded_cents     bigint,
  flagged            boolean,
  window_days        integer,
  rate_threshold_pct numeric,
  min_transactions   integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cfg jsonb; v_days integer; v_threshold numeric; v_min_txn integer; v_since timestamptz;
BEGIN
  -- Reports across EVERY tenant by design, so the only correct gate is
  -- "is this Enrops", never "is this an org admin".
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT ps.value INTO v_cfg FROM platform_settings ps WHERE ps.key = 'refund_watch';
  v_cfg       := COALESCE(v_cfg, '{}'::jsonb);
  v_days      := COALESCE(p_days, (v_cfg->>'window_days')::int, 30);
  v_threshold := COALESCE((v_cfg->>'rate_threshold_pct')::numeric, 15);
  v_min_txn   := COALESCE((v_cfg->>'min_transactions')::int, 5);
  v_since     := now() - make_interval(days => v_days);

  RETURN QUERY
  WITH
  -- A "transaction" is one successful CHARGE, not one registration: a payment
  -- plan is three charges and would otherwise look like a single sale.
  inst_txn AS (
    SELECT i.organization_id AS org, i.stripe_payment_intent_id AS pi, SUM(i.amount_cents)::bigint AS cents
    FROM installments i
    WHERE i.status = 'paid' AND i.paid_at >= v_since AND i.stripe_payment_intent_id IS NOT NULL
    GROUP BY i.organization_id, i.stripe_payment_intent_id
  ),
  -- Single-pay only (no installment rows), so a plan is never counted twice.
  -- Deliberately NOT filtered on payment_method — see defect 2 in the header.
  reg_txn AS (
    SELECT r.organization_id AS org, r.stripe_payment_intent_id AS pi, SUM(r.amount_cents)::bigint AS cents
    FROM registrations r
    WHERE r.stripe_payment_intent_id IS NOT NULL
      AND r.payment_status IN ('paid', 'partial', 'refunded')
      AND r.registered_at >= v_since
      AND NOT EXISTS (SELECT 1 FROM installments i2 WHERE i2.registration_id = r.id)
    GROUP BY r.organization_id, r.stripe_payment_intent_id
  ),
  txn AS (SELECT org, pi, cents FROM inst_txn UNION SELECT org, pi, cents FROM reg_txn),
  txn_agg AS (SELECT org, COUNT(*)::bigint AS n, COALESCE(SUM(cents),0)::bigint AS cents FROM txn GROUP BY org),
  -- Refunded CHARGES, not refund events. Restricted to charges inside the same
  -- window so the ratio compares like with like and cannot exceed 100%.
  ref_agg AS (
    SELECT rf.organization_id AS org,
           COUNT(DISTINCT rf.stripe_payment_intent_id)::bigint AS n,
           COALESCE(SUM(rf.amount_cents), 0)::bigint AS cents,
           COUNT(DISTINCT COALESCE(rf.stripe_refund_id, rf.id::text))::bigint AS events
    FROM refunds rf
    WHERE rf.status = 'succeeded' AND rf.succeeded_at >= v_since
      AND EXISTS (SELECT 1 FROM txn WHERE txn.org = rf.organization_id AND txn.pi = rf.stripe_payment_intent_id)
    GROUP BY rf.organization_id
  )
  SELECT
    o.id, o.slug, o.name,
    COALESCE(t.n, 0)::bigint,
    COALESCE(rr.n, 0)::bigint,
    COALESCE(rr.events, 0)::bigint,
    CASE WHEN COALESCE(t.n,0) = 0 THEN 0::numeric
         ELSE ROUND((COALESCE(rr.n,0)::numeric * 100) / t.n, 1) END,
    COALESCE(t.cents, 0)::bigint,
    COALESCE(rr.cents, 0)::bigint,
    -- The minimum-sales floor is NOT in Arielle's text. Without it a brand-new
    -- operator with one sale and one refund reads 100% and is flagged in their
    -- first week. Tunable alongside the threshold rather than baked in.
    (COALESCE(t.n,0) >= v_min_txn AND COALESCE(t.n,0) > 0
      AND ((COALESCE(rr.n,0)::numeric * 100) / t.n) >= v_threshold),
    v_days, v_threshold, v_min_txn
  FROM organizations o
  LEFT JOIN txn_agg t  ON t.org  = o.id
  LEFT JOIN ref_agg rr ON rr.org = o.id
  WHERE COALESCE(t.n,0) > 0 OR COALESCE(rr.n,0) > 0
  ORDER BY
    (COALESCE(t.n,0) >= v_min_txn AND COALESCE(t.n,0) > 0
      AND ((COALESCE(rr.n,0)::numeric * 100) / GREATEST(t.n,1)) >= v_threshold) DESC,
    CASE WHEN COALESCE(t.n,0) = 0 THEN 0 ELSE (COALESCE(rr.n,0)::numeric * 100) / t.n END DESC,
    o.name;
END
$function$;

-- Postgres grants EXECUTE to PUBLIC by default, so the REVOKE has to be
-- explicit. This one is safe for operators to hold: it enforces
-- is_platform_admin() as its first statement and takes no org argument.
REVOKE EXECUTE ON FUNCTION public.get_operator_refund_rates(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_operator_refund_rates(integer) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_operator_refund_rates(integer) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_operator_refund_rates(integer) TO service_role;

-- ── the hook v4 section 4's last line needs ─────────────────────────────────
-- "Flagged accounts are excluded from the growth triggers in Section 8."
-- Section 8 does not exist yet. This is the predicate it will call, so the rule
-- lives in ONE place when it does. It MUST agree with get_operator_refund_rates
-- above — if the two ever drift, one screen flags an operator the other calls
-- fine. There is a test for exactly that agreement.
CREATE OR REPLACE FUNCTION public.is_operator_refund_flagged(p_org uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cfg jsonb; v_days integer; v_threshold numeric; v_min_txn integer;
  v_since timestamptz; v_txn bigint; v_ref bigint;
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
    SELECT r.stripe_payment_intent_id
    FROM registrations r
    WHERE r.organization_id = p_org AND r.stripe_payment_intent_id IS NOT NULL
      AND r.payment_status IN ('paid','partial','refunded') AND r.registered_at >= v_since
      AND NOT EXISTS (SELECT 1 FROM installments i2 WHERE i2.registration_id = r.id)
    GROUP BY r.stripe_payment_intent_id
  )
  SELECT
    (SELECT COUNT(*) FROM txn),
    (SELECT COUNT(DISTINCT rf.stripe_payment_intent_id)
       FROM refunds rf
      WHERE rf.organization_id = p_org AND rf.status = 'succeeded'
        AND rf.succeeded_at >= v_since
        AND rf.stripe_payment_intent_id IN (SELECT pi FROM txn))
  INTO v_txn, v_ref;

  IF v_txn IS NULL OR v_txn < v_min_txn OR v_txn = 0 THEN RETURN false; END IF;
  RETURN ((COALESCE(v_ref,0)::numeric * 100) / v_txn) >= v_threshold;
END
$function$;

-- BACKEND ONLY. This one is SECURITY DEFINER and takes an arbitrary org id, so
-- granting it to `authenticated` would let any signed-in operator probe another
-- organisation's refund health one uuid at a time. It cannot gate on
-- is_platform_admin() instead, because section 8 will call it from backend code
-- running as the service role, not as a platform admin.
REVOKE EXECUTE ON FUNCTION public.is_operator_refund_flagged(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_operator_refund_flagged(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_operator_refund_flagged(uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.is_operator_refund_flagged(uuid) TO service_role;

COMMENT ON FUNCTION public.is_operator_refund_flagged(uuid) IS
  'v4 section 4: is this operator over the rolling refund-rate threshold? A REPORTING flag only - never gate a refund on it. Must agree with get_operator_refund_rates.';
