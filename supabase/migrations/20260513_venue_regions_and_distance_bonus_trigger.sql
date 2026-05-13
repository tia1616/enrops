-- venue_regions: maps full venue names (camp_sessions.location_name) to the
-- short region labels instructors use in their location preferences. The agent's
-- VENUE_REGION_MAP constant in lib.ts is the source of truth at code-write time;
-- this table is the source of truth at run time and is editable per-tenant.

CREATE TABLE IF NOT EXISTS venue_regions (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_name text NOT NULL,
  region_name text NOT NULL,
  PRIMARY KEY (organization_id, location_name)
);

ALTER TABLE venue_regions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_members_read_venue_regions ON venue_regions;
CREATE POLICY org_members_read_venue_regions ON venue_regions
  FOR SELECT
  USING (organization_id IN (
    SELECT om.organization_id FROM org_members om WHERE om.auth_user_id = auth.uid()
  ));

DROP POLICY IF EXISTS org_admins_write_venue_regions ON venue_regions;
CREATE POLICY org_admins_write_venue_regions ON venue_regions
  FOR ALL
  USING (organization_id IN (
    SELECT om.organization_id FROM org_members om
    WHERE om.auth_user_id = auth.uid() AND om.role = ANY(ARRAY['owner','admin'])
  ));

-- Seed J2S map (sourced from supabase/functions/match-instructors/lib.ts VENUE_REGION_MAP).
INSERT INTO venue_regions (organization_id, location_name, region_name) VALUES
  ('1adf10ad-d091-4aa0-82e3-af331468ea2b', 'Bricks and Mini Figs Beaverton', 'Beaverton'),
  ('1adf10ad-d091-4aa0-82e3-af331468ea2b', 'Camas Community Ed', 'Camas'),
  ('1adf10ad-d091-4aa0-82e3-af331468ea2b', 'Camas Parks and Rec', 'Camas'),
  ('1adf10ad-d091-4aa0-82e3-af331468ea2b', 'Catlin Gabel Summer Camp', 'Portland'),
  ('1adf10ad-d091-4aa0-82e3-af331468ea2b', 'Community of Faith Church', 'West Linn'),
  ('1adf10ad-d091-4aa0-82e3-af331468ea2b', 'Corbett Elementary', 'Corbett'),
  ('1adf10ad-d091-4aa0-82e3-af331468ea2b', 'First Congregational UCC', 'Hillsboro'),
  ('1adf10ad-d091-4aa0-82e3-af331468ea2b', 'Firstenburg Community Center', 'Vancouver, WA'),
  ('1adf10ad-d091-4aa0-82e3-af331468ea2b', 'Forest Grove Parks and Rec', 'Forest Grove'),
  ('1adf10ad-d091-4aa0-82e3-af331468ea2b', 'Happy Valley Annex', 'Happy Valley'),
  ('1adf10ad-d091-4aa0-82e3-af331468ea2b', 'Hillsboro Tyson Rec Center', 'Hillsboro'),
  ('1adf10ad-d091-4aa0-82e3-af331468ea2b', 'Lacamas Lodge', 'Camas'),
  ('1adf10ad-d091-4aa0-82e3-af331468ea2b', 'St. Paul''s Episcopal Church', 'Oregon City'),
  ('1adf10ad-d091-4aa0-82e3-af331468ea2b', 'The Historic Overlook House', 'Portland'),
  ('1adf10ad-d091-4aa0-82e3-af331468ea2b', 'West Linn Parks and Rec', 'West Linn')
ON CONFLICT (organization_id, location_name) DO UPDATE SET region_name = EXCLUDED.region_name;

-- Trigger: auto-set distance_bonus_cents to $50 when the assigned location maps
-- to a region the instructor marked 'unavailable' in their preferences for the
-- session's cycle.
CREATE OR REPLACE FUNCTION compute_distance_bonus()
RETURNS TRIGGER AS $$
DECLARE
  v_cycle uuid;
  v_org uuid;
  v_session_location text;
  v_region text;
  v_pref text;
BEGIN
  SELECT cs.cycle_id, cs.organization_id, cs.location_name
    INTO v_cycle, v_org, v_session_location
  FROM camp_sessions cs WHERE cs.id = NEW.camp_session_id;

  SELECT vr.region_name INTO v_region
  FROM venue_regions vr
  WHERE vr.organization_id = v_org AND vr.location_name = v_session_location;

  IF v_region IS NULL THEN
    NEW.distance_bonus_cents := NULL;
    RETURN NEW;
  END IF;

  SELECT preference INTO v_pref
  FROM instructor_location_preferences
  WHERE instructor_id = NEW.instructor_id
    AND cycle_id = v_cycle
    AND location_name = v_region
  LIMIT 1;

  IF v_pref = 'unavailable' THEN
    NEW.distance_bonus_cents := 5000;
  ELSE
    NEW.distance_bonus_cents := NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_distance_bonus_on_assignment ON camp_assignments;
CREATE TRIGGER set_distance_bonus_on_assignment
BEFORE INSERT OR UPDATE OF camp_session_id, instructor_id
ON camp_assignments
FOR EACH ROW
EXECUTE FUNCTION compute_distance_bonus();

-- Backfill existing rows so they match the rule.
UPDATE camp_assignments ca
SET distance_bonus_cents = CASE
  WHEN EXISTS (
    SELECT 1 FROM camp_sessions cs
    JOIN venue_regions vr ON vr.organization_id = cs.organization_id AND vr.location_name = cs.location_name
    JOIN instructor_location_preferences ilp ON ilp.instructor_id = ca.instructor_id
      AND ilp.cycle_id = cs.cycle_id
      AND ilp.location_name = vr.region_name
      AND ilp.preference = 'unavailable'
    WHERE cs.id = ca.camp_session_id
  ) THEN 5000
  ELSE NULL
END;
