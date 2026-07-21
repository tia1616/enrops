-- 20260721_instructor_survey_sends.sql
--
-- Per-instructor audit log of availability-survey sends. The survey send edge
-- functions (send-availability-survey / send-afterschool-survey) previously
-- wrote only a cycle/term-level "opened_at" flag, so there was no durable record
-- of WHICH instructor was emailed WHEN. This table fills that gap so the Comms
-- per-contact timeline can show "Availability survey sent" per instructor.
-- One row per instructor per send.

CREATE TABLE IF NOT EXISTS instructor_survey_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  instructor_id UUID NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  -- Which survey: camp availability (scheduling_cycles) or afterschool (term).
  survey_kind TEXT NOT NULL
    CHECK (survey_kind IN ('camp_availability', 'afterschool_availability')),
  cycle_id UUID REFERENCES scheduling_cycles(id) ON DELETE SET NULL, -- camps
  term TEXT,                                                          -- afterschool
  status TEXT NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'failed')),
  failure_reason TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_instructor_survey_sends_org
  ON instructor_survey_sends(organization_id);
CREATE INDEX IF NOT EXISTS idx_instructor_survey_sends_instructor
  ON instructor_survey_sends(instructor_id, sent_at DESC);

COMMENT ON TABLE instructor_survey_sends IS 'Per-instructor audit of availability-survey sends (Comms per-contact timeline source).';

ALTER TABLE instructor_survey_sends ENABLE ROW LEVEL SECURITY;

-- Org members read their org's rows. Writes come from the survey send edge
-- functions via the service-role key, so no INSERT policy for authenticated.
CREATE POLICY instructor_survey_sends_org_read
  ON instructor_survey_sends
  FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());

-- Lock down to service-role writes + authenticated read. New tables inherit
-- broad default privileges in this project (anon + authenticated get ALL); strip
-- them so RLS isn't the ONLY thing between anon and this table. Matches the
-- marketing_sends hygiene rather than the looser roster_email_sends default.
REVOKE ALL ON instructor_survey_sends FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON instructor_survey_sends FROM authenticated;
GRANT SELECT ON instructor_survey_sends TO authenticated;
-- INSERTs via the survey send edge functions using the service role only.
