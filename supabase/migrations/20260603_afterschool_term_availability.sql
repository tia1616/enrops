-- Afterschool instructor availability is keyed by TERM (e.g. 'FA26'), not by a
-- camp scheduling cycle. instructor_availability is camp-coupled (cycle_id NOT
-- NULL, week/session_type columns), so afterschool gets its own clean table.
--
-- Differences from camps (per product rules): day-of-week recurring (not weeks),
-- a single afternoon time window (no am/pm/full_day), unavailable dates parsed,
-- max_days = seniority/quota target, per-location preference. No curriculum,
-- no role tier, no enrollment.

CREATE TABLE IF NOT EXISTS public.instructor_term_availability (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  instructor_id      uuid NOT NULL REFERENCES public.instructors(id) ON DELETE CASCADE,
  term               text NOT NULL,
  available_days     text[] NOT NULL DEFAULT '{}',
  earliest_start     time,
  latest_end         time,
  unavailable_dates  date[] DEFAULT '{}',
  max_days           integer,
  location_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes              text,
  needs_confirmation boolean NOT NULL DEFAULT false,
  submitted_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instructor_term_availability_days_check
    CHECK (available_days <@ ARRAY['mon','tue','wed','thu','fri']),
  CONSTRAINT instructor_term_availability_max_days_check
    CHECK (max_days IS NULL OR (max_days >= 1 AND max_days <= 5)),
  CONSTRAINT instructor_term_availability_unique UNIQUE (organization_id, instructor_id, term)
);

ALTER TABLE public.instructor_term_availability ENABLE ROW LEVEL SECURITY;

-- Org owners/admins (and platform admins) manage all rows for their org.
CREATE POLICY instructor_term_availability_org_manage
  ON public.instructor_term_availability
  FOR ALL
  USING (is_org_member(organization_id) OR is_platform_admin())
  WITH CHECK (is_org_member(organization_id) OR is_platform_admin());

-- Instructors read+write only their own row.
CREATE POLICY instructor_term_availability_self
  ON public.instructor_term_availability
  FOR ALL
  USING (instructor_id IN (SELECT id FROM public.instructors WHERE auth_user_id = auth.uid()))
  WITH CHECK (instructor_id IN (SELECT id FROM public.instructors WHERE auth_user_id = auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.instructor_term_availability TO authenticated;

CREATE INDEX IF NOT EXISTS idx_instructor_term_availability_org_term
  ON public.instructor_term_availability (organization_id, term);

-- Offer messages can now reference a program assignment instead of a camp one.
ALTER TABLE public.instructor_offer_messages
  ALTER COLUMN camp_assignment_id DROP NOT NULL;

ALTER TABLE public.instructor_offer_messages
  ADD COLUMN IF NOT EXISTS program_assignment_id uuid
    REFERENCES public.program_assignments(id) ON DELETE CASCADE;

ALTER TABLE public.instructor_offer_messages
  ADD CONSTRAINT instructor_offer_messages_one_assignment_check
    CHECK (num_nonnulls(camp_assignment_id, program_assignment_id) = 1);

CREATE INDEX IF NOT EXISTS idx_offer_messages_program_assignment
  ON public.instructor_offer_messages (program_assignment_id);
