-- 20260529_program_assignments_table.sql
--
-- FA26 afterschool: instructor assignment to a program for the term.
-- After-school equivalent of camp_assignments. One row per
-- (program, instructor) tracks the contractor's engagement for the term.
--
-- Mirrors camp_assignments shape so:
--   - the engagement letter / offer-acceptance flow can be a near-clone
--   - distance bonus accrues once per regular instructor per program
--   - the pay-line resolver (v_effective_pay_lines) can JOIN to this
--     table the same way it JOINs to camp_assignments today
--
-- Subs land in assignment_substitutions with parent_assignment_type='program'
-- and parent_assignment_id pointing at one of these rows.

CREATE TABLE program_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  program_id UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  instructor_id UUID NOT NULL REFERENCES instructors(id) ON DELETE RESTRICT,

  -- Role for THIS engagement. Pay tier comes from here, not from
  -- instructors.contractor_tier — same reason as camps: an instructor can
  -- be lead on one program and developing on another.
  role TEXT NOT NULL CHECK (role IN ('lead', 'developing')),

  -- Status enum matches camp_assignments so the schedule UI can render
  -- both kinds of rows with the same status badges + actions.
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending',
      'invited',
      'offered',
      'accepted',
      'declined',
      'change_requested',
      'withdrawn',
      'confirmed',
      'cancelled'
    )),

  assigned_by UUID REFERENCES auth.users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  instructor_response_at TIMESTAMPTZ,
  decline_reason TEXT,
  change_request_message TEXT,
  admin_response_message TEXT,
  deadline DATE,
  email_sent_at TIMESTAMPTZ,
  email_viewed_at TIMESTAMPTZ,
  reminder_sent_at TIMESTAMPTZ,

  -- Distance bonus per the engagement letter — paid once per regular
  -- instructor who actually taught. Same pattern as camp_assignments.
  distance_bonus_cents INTEGER,
  distance_bonus_paid_at TIMESTAMPTZ,
  distance_bonus_payout_id UUID REFERENCES instructor_payouts(id) ON DELETE SET NULL,

  flagged_reason TEXT,
  flags TEXT[] NOT NULL DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An instructor can only have one active assignment per program at a time.
-- Withdrawn / declined / cancelled rows are kept for audit but don't count.
CREATE UNIQUE INDEX program_assignments_one_active_per_pair
  ON program_assignments (program_id, instructor_id)
  WHERE status NOT IN ('declined', 'withdrawn', 'cancelled');

CREATE INDEX program_assignments_org_id_idx
  ON program_assignments (organization_id);
CREATE INDEX program_assignments_instructor_id_idx
  ON program_assignments (instructor_id);
CREATE INDEX program_assignments_program_id_idx
  ON program_assignments (program_id);

-- ──────────────────────────────────────────────────────────────────────
-- RLS
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE program_assignments ENABLE ROW LEVEL SECURITY;

-- Org owners/admins can do anything within their org. Mirrors how
-- camp_assignments is treated by the admin schedule + offers code.
CREATE POLICY program_assignments_org_members_manage
  ON program_assignments
  FOR ALL
  USING (is_org_member(organization_id) OR is_platform_admin())
  WITH CHECK (is_org_member(organization_id) OR is_platform_admin());

-- The assigned instructor can read their own row (portal: "My schedule").
CREATE POLICY program_assignments_instructor_self_read
  ON program_assignments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM instructors i
      WHERE i.id = program_assignments.instructor_id
        AND i.auth_user_id = auth.uid()
    )
  );

-- Per the project's 2026-10-30 migration rule: explicit grants on new
-- public tables. RLS still gates row visibility.
GRANT SELECT, INSERT, UPDATE, DELETE ON program_assignments TO authenticated;
-- No anon access — assignment rows are operator/instructor-only.
