-- 20260529_pr35_fa26_audit_fixes.sql
--
-- PR 3.5 of the FA26 afterschool + sub flow build. Closes three audit
-- findings from PRs 1-3 before extending payroll in PR 4.
--
-- 1. program_assignments status drift.
--    The table shipped with the wrong enum
--    (pending, invited, offered, accepted, declined, change_requested,
--    withdrawn, confirmed, cancelled). It must mirror camp_assignments
--    verbatim so the schedule UI, payroll grouping, and offer-acceptance
--    flow render both kinds of rows the same way. Camps enum is
--    proposed, confirmed, change_requested, published, withdrawn, declined.
--    Zero rows in program_assignments today so no data remap needed.
--    Also fix the default ('pending' -> 'proposed') and the partial unique
--    index, whose exclusion list referenced 'cancelled' (no longer valid).
--
-- 2. assignment_substitutions sub-instructor column restriction.
--    RLS policy assignment_substitutions_sub_self_update_status lets the
--    sub UPDATE any column of their row. Postgres RLS is row-level, not
--    column-level. A malicious sub could change sub_tier from 'developing'
--    to 'lead' and inflate effective_tier in v_effective_pay_lines. New
--    BEFORE UPDATE trigger: when the caller IS the sub (auth.uid() matches
--    instructors.auth_user_id for the row's sub_instructor_id), reject any
--    column change other than status, decline_reason, declined_at,
--    email_viewed_at, updated_at. Admin paths (org_members policy) and
--    service-role paths bypass naturally since auth.uid() does not resolve
--    to the sub instructor.
--
-- 3. Sub-instructor org defense.
--    validate_assignment_substitution_parent() checks that the row's
--    organization_id matches the parent assignment's org. Extend it to
--    also check that sub_instructor_id belongs to the same org. Closes a
--    path where a misconfigured caller could link a sub from org A to a
--    parent assignment in org B. The trigger's UPDATE clause is widened
--    to include sub_instructor_id so swapping subs re-runs the check.

-- ──────────────────────────────────────────────────────────────────────
-- 1. program_assignments status enum + default + partial index.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE program_assignments
  ALTER COLUMN status DROP DEFAULT;

ALTER TABLE program_assignments
  DROP CONSTRAINT program_assignments_status_check;

ALTER TABLE program_assignments
  ADD CONSTRAINT program_assignments_status_check
  CHECK (status IN (
    'proposed',
    'confirmed',
    'change_requested',
    'published',
    'withdrawn',
    'declined'
  ));

ALTER TABLE program_assignments
  ALTER COLUMN status SET DEFAULT 'proposed';

-- Partial unique index: active = not declined and not withdrawn.
-- Old definition listed 'cancelled' (no longer a valid status).
DROP INDEX program_assignments_one_active_per_pair;

CREATE UNIQUE INDEX program_assignments_one_active_per_pair
  ON program_assignments (program_id, instructor_id)
  WHERE status NOT IN ('declined', 'withdrawn');

-- ──────────────────────────────────────────────────────────────────────
-- 2. assignment_substitutions: BEFORE UPDATE column restriction for sub.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION restrict_assignment_substitution_sub_updates()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_is_sub BOOLEAN;
BEGIN
  -- Same identity resolution as the RLS update policy. Service-role and
  -- unauthenticated callers get auth.uid() = NULL, so the EXISTS is false
  -- and the trigger does not restrict. Org-admin callers do not match
  -- either (they are org_members, not the sub instructor), so they also
  -- bypass. Only the sub themselves trips the restriction.
  SELECT EXISTS (
    SELECT 1 FROM instructors i
    WHERE i.id = OLD.sub_instructor_id
      AND i.auth_user_id = auth.uid()
  ) INTO v_caller_is_sub;

  IF NOT v_caller_is_sub THEN
    RETURN NEW;
  END IF;

  -- Sub may change only: status, decline_reason, declined_at,
  -- email_viewed_at, updated_at. Any other column delta is rejected.
  IF NEW.parent_assignment_id   IS DISTINCT FROM OLD.parent_assignment_id   OR
     NEW.parent_assignment_type IS DISTINCT FROM OLD.parent_assignment_type OR
     NEW.sub_instructor_id      IS DISTINCT FROM OLD.sub_instructor_id      OR
     NEW.date                   IS DISTINCT FROM OLD.date                   OR
     NEW.sub_tier               IS DISTINCT FROM OLD.sub_tier               OR
     NEW.assigned_at            IS DISTINCT FROM OLD.assigned_at            OR
     NEW.assigned_by            IS DISTINCT FROM OLD.assigned_by            OR
     NEW.notes                  IS DISTINCT FROM OLD.notes                  OR
     NEW.organization_id        IS DISTINCT FROM OLD.organization_id        OR
     NEW.email_sent_at          IS DISTINCT FROM OLD.email_sent_at          OR
     NEW.created_at             IS DISTINCT FROM OLD.created_at             THEN
    RAISE EXCEPTION 'sub_instructor may only update status, decline_reason, declined_at, email_viewed_at, updated_at'
      USING ERRCODE = '42501'; -- insufficient_privilege
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_restrict_assignment_substitution_sub_updates
  BEFORE UPDATE ON assignment_substitutions
  FOR EACH ROW
  EXECUTE FUNCTION restrict_assignment_substitution_sub_updates();

-- ──────────────────────────────────────────────────────────────────────
-- 3. validate_assignment_substitution_parent() now also checks sub org.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION validate_assignment_substitution_parent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_parent_org UUID;
  v_sub_org    UUID;
BEGIN
  IF NEW.parent_assignment_type = 'camp' THEN
    SELECT organization_id INTO v_parent_org
    FROM camp_assignments
    WHERE id = NEW.parent_assignment_id;
    IF v_parent_org IS NULL THEN
      RAISE EXCEPTION 'parent_assignment_id % does not exist in camp_assignments',
        NEW.parent_assignment_id
        USING ERRCODE = '23503'; -- foreign_key_violation
    END IF;
  ELSIF NEW.parent_assignment_type = 'program' THEN
    SELECT organization_id INTO v_parent_org
    FROM program_assignments
    WHERE id = NEW.parent_assignment_id;
    IF v_parent_org IS NULL THEN
      RAISE EXCEPTION 'parent_assignment_id % does not exist in program_assignments',
        NEW.parent_assignment_id
        USING ERRCODE = '23503';
    END IF;
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_parent_org THEN
    RAISE EXCEPTION 'assignment_substitutions.organization_id (%) does not match parent assignment org (%)',
      NEW.organization_id, v_parent_org
      USING ERRCODE = '23514'; -- check_violation
  END IF;

  -- Sub instructor must belong to the same org as the parent assignment.
  SELECT organization_id INTO v_sub_org
  FROM instructors
  WHERE id = NEW.sub_instructor_id;

  IF v_sub_org IS NULL THEN
    RAISE EXCEPTION 'sub_instructor_id % does not exist in instructors',
      NEW.sub_instructor_id
      USING ERRCODE = '23503';
  END IF;

  IF v_sub_org IS DISTINCT FROM v_parent_org THEN
    RAISE EXCEPTION 'sub_instructor_id % belongs to org % but parent assignment is in org %',
      NEW.sub_instructor_id, v_sub_org, v_parent_org
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- Widen the UPDATE column list so swapping subs re-runs validation.
DROP TRIGGER trg_validate_assignment_substitution_parent
  ON assignment_substitutions;

CREATE TRIGGER trg_validate_assignment_substitution_parent
  BEFORE INSERT OR UPDATE OF
    parent_assignment_id,
    parent_assignment_type,
    organization_id,
    sub_instructor_id
  ON assignment_substitutions
  FOR EACH ROW
  EXECUTE FUNCTION validate_assignment_substitution_parent();
