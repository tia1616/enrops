-- RA-3: get_revenue_activity — reverse-chron merged money feed for Finances → Activity.
-- Same gate/security as get_revenue_summary (SECURITY DEFINER + can_handle_money).
-- Sources: pay-in-full payments (registered_at), installment payments (paid_at),
-- succeeded refunds (succeeded_at, shown NEGATIVE). Each row sorted by its own
-- money-date; paginated (limit/offset). p_term scopes to after-school programs
-- (camps have no term -> appear only in the date-based periods).
-- Label = programs.curriculum or camp_sessions.curriculum_name; family = student name.
--
-- Verified on staging: gate forbids unauth; payment-row count == summary.paid_count (44);
-- refund magnitude == summary.refunded_cents (24000); pagination caps correctly.
CREATE OR REPLACE FUNCTION public.get_revenue_activity(
  p_org    uuid,
  p_from   timestamptz DEFAULT NULL,
  p_to     timestamptz DEFAULT NULL,
  p_term   text        DEFAULT NULL,
  p_limit  int         DEFAULT 50,
  p_offset int         DEFAULT 0
) RETURNS TABLE (
  kind            text,
  registration_id uuid,
  family_name     text,
  label           text,
  amount_cents    bigint,
  occurred_at     timestamptz
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
  reg_label AS (
    SELECT r.id AS reg_id, r.program_id,
           NULLIF(trim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,'')), '') AS family,
           coalesce(p.curriculum, cs.curriculum_name, 'Registration') AS lbl
    FROM registrations r
    LEFT JOIN students s       ON s.id = r.student_id
    LEFT JOIN programs p       ON p.id = r.program_id
    LEFT JOIN camp_sessions cs ON cs.id = r.camp_session_id
    WHERE r.organization_id = p_org
  ),
  feed AS (
    SELECT 'payment'::text AS k, r.id AS reg, rl.family AS fam, rl.lbl AS lab,
           r.amount_cents::bigint AS amt, r.registered_at AS occ
    FROM registrations r JOIN reg_label rl ON rl.reg_id = r.id
    WHERE r.organization_id = p_org AND r.payment_method = 'stripe'
      AND r.payment_status IN ('paid','partial','refunded')
      AND (p_term IS NULL OR r.program_id IN (SELECT id FROM term_prog))
    UNION ALL
    SELECT 'installment', i.registration_id, rl.family, rl.lbl,
           i.amount_cents::bigint, i.paid_at
    FROM installments i JOIN reg_label rl ON rl.reg_id = i.registration_id
    WHERE i.organization_id = p_org AND i.status = 'paid'
      AND (p_term IS NULL OR rl.program_id IN (SELECT id FROM term_prog))
    UNION ALL
    SELECT 'refund', rf.registration_id, rl.family, rl.lbl,
           (-rf.amount_cents)::bigint, rf.succeeded_at
    FROM refunds rf JOIN reg_label rl ON rl.reg_id = rf.registration_id
    WHERE rf.organization_id = p_org AND rf.status = 'succeeded'
      AND (p_term IS NULL OR rl.program_id IN (SELECT id FROM term_prog))
  )
  SELECT f.k, f.reg, f.fam, f.lab, f.amt, f.occ
  FROM feed f
  WHERE f.occ IS NOT NULL
    AND (p_from IS NULL OR f.occ >= p_from)
    AND (p_to   IS NULL OR f.occ <  p_to)
  ORDER BY f.occ DESC
  LIMIT GREATEST(coalesce(p_limit,50), 0) OFFSET GREATEST(coalesce(p_offset,0), 0);
END
$$;

REVOKE ALL ON FUNCTION public.get_revenue_activity(uuid, timestamptz, timestamptz, text, int, int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_revenue_activity(uuid, timestamptz, timestamptz, text, int, int) TO authenticated;
