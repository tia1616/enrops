-- 20260528_effective_pay_line_resolver.sql
--
-- Chunk 2 of the Run Payroll build.
--
-- The "effective-instructor resolver" — payroll groups by who SHOULD BE
-- PAID for a confirmation, not who was originally assigned. Today (no
-- substitutions table yet) effective = original. When the FA26 substitutions
-- work ships, the resolver routes pay to the sub automatically — zero
-- payroll-code changes needed (the directive from the parallel agent
-- explicitly required this contract).
--
-- Two pieces:
--   1. A placeholder VIEW `assignment_substitutions` that mirrors the
--      schema the parallel agent plans to ship. Returns 0 rows today. When
--      they ship their migration, they DROP this view, then CREATE TABLE.
--      All payroll JOINs continue to work.
--   2. A VIEW `v_effective_pay_lines` that joins confirmations to
--      instructors + camp_assignments + (placeholder or real)
--      substitutions, and exposes `effective_instructor_id`,
--      `effective_tier`, and `source` ('regular' | 'sub') as columns. The
--      Payroll page and pay-instructor edge fn both read from this view.
--
-- The placeholder view's schema matches the agent's spec exactly:
--   parent_assignment_id, parent_assignment_type, sub_instructor_id, date,
--   status, sub_tier, etc.

-- ──────────────────────────────────────────────────────────────────────
-- (1) Placeholder VIEW for assignment_substitutions
--
-- HANDOFF NOTE: when the FA26 substitutions migration ships, drop this
-- view with `DROP VIEW IF EXISTS assignment_substitutions CASCADE;` then
-- CREATE TABLE. The CASCADE removes the dependent v_effective_pay_lines
-- view; recreate it after via re-running this migration's view block.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW assignment_substitutions AS
SELECT
  NULL::uuid       AS id,
  NULL::uuid       AS parent_assignment_id,
  NULL::text       AS parent_assignment_type,
  NULL::uuid       AS sub_instructor_id,
  NULL::date       AS date,
  NULL::text       AS status,
  NULL::text       AS sub_tier,
  NULL::timestamptz AS assigned_at,
  NULL::uuid       AS assigned_by,
  NULL::text       AS notes
WHERE false;

COMMENT ON VIEW assignment_substitutions IS 'PLACEHOLDER until FA26 substitutions work. Returns 0 rows. Drop + replace with real table when ready.';

-- ──────────────────────────────────────────────────────────────────────
-- (2) v_effective_pay_lines — the canonical pay-line view
--
-- One row per session_delivery_confirmation, with effective_instructor_id
-- and effective_tier resolved.
--
-- When the placeholder is replaced with the real substitutions table, the
-- LEFT JOIN starts finding sub rows for substituted days → behavior
-- changes automatically. No code changes needed.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW v_effective_pay_lines AS
SELECT
  c.id                   AS confirmation_id,
  c.organization_id,
  c.camp_session_id,
  c.program_id,
  c.session_date,
  c.session_type,
  c.confirmed_by,
  c.confirmed_at,
  c.pay_status,
  c.pay_amount_cents,
  c.pay_adjustment_cents,
  c.pay_adjustment_reason,
  c.instructor_payout_id,
  c.created_at           AS confirmation_created_at,
  c.instructor_id        AS original_instructor_id,
  COALESCE(sub.sub_instructor_id, c.instructor_id) AS effective_instructor_id,
  COALESCE(sub.sub_tier,  i.contractor_tier)       AS effective_tier,
  CASE
    WHEN sub.sub_instructor_id IS NOT NULL THEN 'sub'
    ELSE 'regular'
  END                    AS source,
  -- Carry the camp_assignment row's distance_bonus_cents so payroll can
  -- decide whether to include it. The bonus belongs to the REGULAR
  -- assignment (subs don't earn it), so we only expose it when source=
  -- 'regular' to keep downstream code from accidentally paying a sub.
  CASE
    WHEN sub.sub_instructor_id IS NULL THEN ca.distance_bonus_cents
    ELSE NULL
  END                    AS distance_bonus_cents_if_regular,
  ca.id                  AS camp_assignment_id,
  ca.status              AS camp_assignment_status,
  ca.distance_bonus_paid_at,
  ca.distance_bonus_payout_id
FROM session_delivery_confirmations c
JOIN instructors i
  ON i.id = c.instructor_id
LEFT JOIN camp_assignments ca
  ON ca.instructor_id = c.instructor_id
 AND ca.camp_session_id = c.camp_session_id
LEFT JOIN assignment_substitutions sub
  ON sub.parent_assignment_id = ca.id
 AND sub.parent_assignment_type = 'camp'
 AND sub.date = c.session_date;

COMMENT ON VIEW v_effective_pay_lines IS 'Canonical pay-line view: one row per confirmation with effective_instructor_id, effective_tier, source. Read by Payroll page + pay-instructor edge fn. JOINs to placeholder assignment_substitutions view today; becomes sub-aware automatically when real table ships.';
