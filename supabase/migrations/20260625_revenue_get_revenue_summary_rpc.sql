-- RA-2: get_revenue_summary — money-coming-in summary for Finances → Activity tab.
-- Spec: docs/handoffs/2026-06-08-revenue-activity-view-spec.md (formula corrected
-- 2026-06-25 to be refund-robust; see [[project_enrops_revenue_activity_view]]).
--
-- SECURITY DEFINER + can_handle_money(p_org) gate: owner/admin only (staff/viewer
-- get nothing), and refuses any org the caller is not an admin of (cross-tenant safe).
-- Formula: gross stripe captured (payment_status in paid/partial/refunded — NOT
-- status='confirmed', so a paid-then-refunded reg isn't double-removed)
--   + installments paid − succeeded refunds. Camp money is included (registrations
--   span program + camp); p_term scopes ONLY to after-school programs (camps have
--   no term — they show in the date-based periods). All aggregation is SQL-side.
-- paid_count = distinct PAYING FAMILIES (parent_id) with any collected money
--   (pay-in-full OR a paid installment) — family-centric, not raw registration count.
--
-- INVARIANT (verified 0 nulls on prod): a paid installment has paid_at, a succeeded
-- refund has succeeded_at, a counted registration has registered_at — so the feed
-- (get_revenue_activity) never drops a row this summary counts.
--
-- Verified on staging: gate raises forbidden unauth; cross-tenant forbidden; collected
-- equals the standalone corrected formula (match=true). Prod oracle: $9,490.16 all-time.
CREATE OR REPLACE FUNCTION public.get_revenue_summary(
  p_org   uuid,
  p_from  timestamptz DEFAULT NULL,
  p_to    timestamptz DEFAULT NULL,
  p_term  text        DEFAULT NULL
) RETURNS TABLE (
  collected_cents     bigint,
  refunded_cents      bigint,
  expected_soon_cents bigint,
  paid_count          bigint,
  external_count      bigint,
  has_enrops_payments boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NOT can_handle_money(p_org) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH term_prog AS (
    SELECT id FROM programs WHERE organization_id = p_org AND (p_term IS NULL OR term = p_term)
  ),
  pif AS (
    SELECT r.id, r.amount_cents, r.parent_id
    FROM registrations r
    WHERE r.organization_id = p_org
      AND r.payment_method = 'stripe'
      AND r.payment_status IN ('paid','partial','refunded')
      AND (p_from IS NULL OR r.registered_at >= p_from)
      AND (p_to   IS NULL OR r.registered_at <  p_to)
      AND (p_term IS NULL OR r.program_id IN (SELECT id FROM term_prog))
  ),
  inst_paid AS (
    SELECT i.amount_cents, r.parent_id
    FROM installments i JOIN registrations r ON r.id = i.registration_id
    WHERE i.organization_id = p_org AND i.status = 'paid'
      AND (p_from IS NULL OR i.paid_at >= p_from)
      AND (p_to   IS NULL OR i.paid_at <  p_to)
      AND (p_term IS NULL OR r.program_id IN (SELECT id FROM term_prog))
  ),
  ref AS (
    SELECT rf.amount_cents
    FROM refunds rf
    WHERE rf.organization_id = p_org AND rf.status = 'succeeded'
      AND (p_from IS NULL OR rf.succeeded_at >= p_from)
      AND (p_to   IS NULL OR rf.succeeded_at <  p_to)
      AND (p_term IS NULL OR rf.registration_id IN
            (SELECT r.id FROM registrations r WHERE r.program_id IN (SELECT id FROM term_prog)))
  ),
  inst_pending AS (
    SELECT i.amount_cents
    FROM installments i
    WHERE i.organization_id = p_org AND i.status = 'pending'
      AND (p_term IS NULL OR i.registration_id IN
            (SELECT r.id FROM registrations r WHERE r.program_id IN (SELECT id FROM term_prog)))
  ),
  ext AS (
    SELECT r.id
    FROM registrations r
    WHERE r.organization_id = p_org AND r.payment_method IS NULL
      AND (p_from IS NULL OR r.registered_at >= p_from)
      AND (p_to   IS NULL OR r.registered_at <  p_to)
      AND (p_term IS NULL OR r.program_id IN (SELECT id FROM term_prog))
  ),
  paid_families AS (
    SELECT parent_id FROM pif       WHERE parent_id IS NOT NULL
    UNION
    SELECT parent_id FROM inst_paid WHERE parent_id IS NOT NULL
  )
  SELECT
    (COALESCE((SELECT SUM(amount_cents) FROM pif),0)
      + COALESCE((SELECT SUM(amount_cents) FROM inst_paid),0)
      - COALESCE((SELECT SUM(amount_cents) FROM ref),0))::bigint,
    COALESCE((SELECT SUM(amount_cents) FROM ref),0)::bigint,
    COALESCE((SELECT SUM(amount_cents) FROM inst_pending),0)::bigint,
    (SELECT COUNT(*) FROM paid_families)::bigint,
    (SELECT COUNT(*) FROM ext)::bigint,
    EXISTS (SELECT 1 FROM registrations r
            WHERE r.organization_id = p_org AND r.payment_method = 'stripe'
              AND r.payment_status IN ('paid','partial','refunded'));
END
$$;

REVOKE ALL ON FUNCTION public.get_revenue_summary(uuid, timestamptz, timestamptz, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_revenue_summary(uuid, timestamptz, timestamptz, text) TO authenticated;
