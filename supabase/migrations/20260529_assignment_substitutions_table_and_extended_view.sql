-- 20260529_assignment_substitutions_table_and_extended_view.sql
--
-- PR 2 of the FA26 afterschool + sub flow build.
--
-- Replaces the placeholder VIEW assignment_substitutions (shipped by the
-- payroll agent in 20260528_effective_pay_line_resolver.sql) with a real
-- TABLE, and extends v_effective_pay_lines to cover programs alongside
-- camps.
--
-- Once this migration lands:
--   - Subs can be inserted via app code → v_effective_pay_lines starts
--     returning them as `source='sub'` rows automatically.
--   - Afterschool session_delivery_confirmations (with program_id set,
--     camp_session_id NULL) now appear in v_effective_pay_lines with
--     program_assignment_id + program_assignment_status populated.
--   - Existing payroll code reading camp_assignment_id keeps working for
--     camps. For programs those columns are NULL; afterschool-aware
--     payroll code reads program_assignment_id instead.
--
-- The polymorphic parent_assignment_id can't have a real FK (since it
-- points to camp_assignments OR program_assignments). A BEFORE INSERT
-- OR UPDATE trigger validates the reference instead.

-- ──────────────────────────────────────────────────────────────────────
-- 1. Drop the placeholder VIEW + the dependent view.
-- ──────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS v_effective_pay_lines;
DROP VIEW IF EXISTS assignment_substitutions;

-- ──────────────────────────────────────────────────────────────────────
-- 2. Real assignment_substitutions TABLE.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE assignment_substitutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Polymorphic parent: camp_assignments.id or program_assignments.id.
  -- No FK constraint (postgres doesn't support polymorphic FKs); a
  -- trigger below validates the reference on INSERT and UPDATE.
  parent_assignment_id UUID NOT NULL,
  parent_assignment_type TEXT NOT NULL
    CHECK (parent_assignment_type IN ('camp', 'program')),

  sub_instructor_id UUID NOT NULL REFERENCES instructors(id) ON DELETE RESTRICT,
  date DATE NOT NULL,

  -- Sub's lifecycle. 'pending' before they respond; 'confirmed' when
  -- they accept; 'declined' if they pass; 'taught' / 'missed' after the
  -- day passes (set by the daily check-in flow via the resolver).
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'declined', 'taught', 'missed')),

  -- Sub's tier for THIS day. May differ from their default contractor_tier
  -- if admin needs to override (e.g., experienced sub running developing
  -- because the camp's lead is on PTO).
  sub_tier TEXT NOT NULL CHECK (sub_tier IN ('lead', 'developing')),

  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by UUID REFERENCES auth.users(id),
  notes TEXT,

  -- Org scoping for RLS + audit.
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  -- Email tracking — sub gets offered the day via Ennie email.
  email_sent_at TIMESTAMPTZ,
  email_viewed_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  decline_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One sub per assignment per day. Re-subbing the same day means
  -- updating this row (e.g., status declined → assign a different sub by
  -- updating sub_instructor_id), not creating a second row.
  UNIQUE (parent_assignment_id, parent_assignment_type, date)
);

CREATE INDEX assignment_substitutions_sub_instructor_id_idx
  ON assignment_substitutions (sub_instructor_id);
CREATE INDEX assignment_substitutions_org_id_idx
  ON assignment_substitutions (organization_id);
CREATE INDEX assignment_substitutions_date_idx
  ON assignment_substitutions (date);

COMMENT ON TABLE assignment_substitutions IS
  'Single-day substitute instructor assignments. Polymorphic parent: parent_assignment_type=''camp'' references camp_assignments.id; ''program'' references program_assignments.id. v_effective_pay_lines LEFT JOINs to this to route pay to the sub when one exists for the date.';

-- ──────────────────────────────────────────────────────────────────────
-- 3. Polymorphic FK validation trigger.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION validate_assignment_substitution_parent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org UUID;
BEGIN
  IF NEW.parent_assignment_type = 'camp' THEN
    SELECT organization_id INTO v_org
    FROM camp_assignments
    WHERE id = NEW.parent_assignment_id;
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'parent_assignment_id % does not exist in camp_assignments', NEW.parent_assignment_id
        USING ERRCODE = '23503'; -- foreign_key_violation
    END IF;
  ELSIF NEW.parent_assignment_type = 'program' THEN
    SELECT organization_id INTO v_org
    FROM program_assignments
    WHERE id = NEW.parent_assignment_id;
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'parent_assignment_id % does not exist in program_assignments', NEW.parent_assignment_id
        USING ERRCODE = '23503';
    END IF;
  END IF;

  -- Org consistency: the sub row's org must match the parent assignment's org.
  -- Prevents a misconfigured caller from cross-tenant-linking.
  IF NEW.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'assignment_substitutions.organization_id (%) does not match parent assignment org (%)',
      NEW.organization_id, v_org
      USING ERRCODE = '23514'; -- check_violation
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_assignment_substitution_parent
  BEFORE INSERT OR UPDATE OF parent_assignment_id, parent_assignment_type, organization_id
  ON assignment_substitutions
  FOR EACH ROW
  EXECUTE FUNCTION validate_assignment_substitution_parent();

-- ──────────────────────────────────────────────────────────────────────
-- 4. RLS + grants.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE assignment_substitutions ENABLE ROW LEVEL SECURITY;

-- Org owners/admins manage their org's substitutions.
CREATE POLICY assignment_substitutions_org_members_manage
  ON assignment_substitutions
  FOR ALL
  USING (is_org_member(organization_id) OR is_platform_admin())
  WITH CHECK (is_org_member(organization_id) OR is_platform_admin());

-- The sub instructor can read their own sub rows + update status
-- (accept / decline). They can't reassign the parent or change the date.
-- App code enforces "only status and decline_reason are writable" — RLS
-- enforces visibility.
CREATE POLICY assignment_substitutions_sub_self_read
  ON assignment_substitutions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM instructors i
      WHERE i.id = assignment_substitutions.sub_instructor_id
        AND i.auth_user_id = auth.uid()
    )
  );

CREATE POLICY assignment_substitutions_sub_self_update_status
  ON assignment_substitutions
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM instructors i
      WHERE i.id = assignment_substitutions.sub_instructor_id
        AND i.auth_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM instructors i
      WHERE i.id = assignment_substitutions.sub_instructor_id
        AND i.auth_user_id = auth.uid()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON assignment_substitutions TO authenticated;
-- No anon — sub rows expose instructor + scheduling info.

-- ──────────────────────────────────────────────────────────────────────
-- 5. Recreate v_effective_pay_lines, now covering programs.
--
-- Two-branch UNION ALL: one for camps (joins to camp_assignments) and
-- one for programs (joins to program_assignments). A confirmation row
-- has either camp_session_id OR program_id, never both, so the branches
-- are disjoint and UNION ALL is safe.
--
-- Existing payroll code reads camp_assignment_id + groups by
-- (effective_instructor_id, camp_session_id). For camp rows, those
-- columns are populated; program_assignment_id is NULL. Vice versa for
-- program rows. PR 4 extends payroll to also group by program_id.
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
  CASE
    WHEN sub.sub_instructor_id IS NULL THEN ca.distance_bonus_cents
    ELSE NULL
  END                    AS distance_bonus_cents_if_regular,
  ca.id                  AS camp_assignment_id,
  ca.status              AS camp_assignment_status,
  NULL::uuid             AS program_assignment_id,
  NULL::text             AS program_assignment_status,
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
 AND sub.date = c.session_date
WHERE c.camp_session_id IS NOT NULL

UNION ALL

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
  CASE
    WHEN sub.sub_instructor_id IS NULL THEN pa.distance_bonus_cents
    ELSE NULL
  END                    AS distance_bonus_cents_if_regular,
  NULL::uuid             AS camp_assignment_id,
  NULL::text             AS camp_assignment_status,
  pa.id                  AS program_assignment_id,
  pa.status              AS program_assignment_status,
  pa.distance_bonus_paid_at,
  pa.distance_bonus_payout_id
FROM session_delivery_confirmations c
JOIN instructors i
  ON i.id = c.instructor_id
LEFT JOIN program_assignments pa
  ON pa.instructor_id = c.instructor_id
 AND pa.program_id = c.program_id
LEFT JOIN assignment_substitutions sub
  ON sub.parent_assignment_id = pa.id
 AND sub.parent_assignment_type = 'program'
 AND sub.date = c.session_date
WHERE c.program_id IS NOT NULL;

COMMENT ON VIEW v_effective_pay_lines IS
  'Canonical pay-line view: one row per session_delivery_confirmation with effective_instructor_id, effective_tier, source (regular | sub), distance_bonus_cents_if_regular. Camp rows expose camp_assignment_id/_status; program rows expose program_assignment_id/_status (the other set is NULL). Read by Payroll page + pay-instructor edge fn. Substitutions table is now real — sub rows route pay to sub_instructor_id automatically.';
