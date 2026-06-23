-- 20260623_program_locations_district_link.sql
--
-- Part of the Schools & Partners redesign. A venue (program_locations row)
-- physically sits inside at most one district. Until now the only district
-- signal was the free-text `program_locations.district` column, which drives
-- derive_program_session_dates() -> district_calendars (no-school dates).
-- That free-text column is LEFT UNTOUCHED here -- it stays load-bearing.
--
-- This adds an OPTIONAL structured link from a venue to its district. A
-- "district" is modelled as a partners row of type 'school_district' that
-- holds district-wide flyer/marketing rules + gatekeeper contacts. The link
-- lets the unified Schools & Partners UI show a school its district's flyer
-- rules without fragile free-text matching.
--
-- Additive and safe: the column is nullable, backfilled later during the
-- operator-confirmed reconciliation pass. Nothing reads it yet.

ALTER TABLE program_locations
  ADD COLUMN IF NOT EXISTS district_id UUID
    REFERENCES partners(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_program_locations_district_id
  ON program_locations(district_id);

-- Cross-table org integrity for BOTH partner_id (the owning school/org) and
-- district_id (the grouping district). A location's partner and district must
-- belong to the same organisation. Extends the existing same-org trigger so
-- there is a single source of truth for the rule.
CREATE OR REPLACE FUNCTION program_locations_partner_same_org()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  partner_org UUID;
  district_org UUID;
BEGIN
  IF NEW.partner_id IS NOT NULL THEN
    SELECT organization_id INTO partner_org FROM partners WHERE id = NEW.partner_id;
    IF partner_org IS NULL THEN
      RAISE EXCEPTION 'partner % not found', NEW.partner_id;
    END IF;
    IF partner_org <> NEW.organization_id THEN
      RAISE EXCEPTION 'partner % belongs to a different organisation', NEW.partner_id;
    END IF;
  END IF;

  IF NEW.district_id IS NOT NULL THEN
    SELECT organization_id INTO district_org FROM partners WHERE id = NEW.district_id;
    IF district_org IS NULL THEN
      RAISE EXCEPTION 'district partner % not found', NEW.district_id;
    END IF;
    IF district_org <> NEW.organization_id THEN
      RAISE EXCEPTION 'district partner % belongs to a different organisation', NEW.district_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_program_locations_partner_same_org ON program_locations;
CREATE TRIGGER trg_program_locations_partner_same_org
  BEFORE INSERT OR UPDATE OF partner_id, district_id, organization_id ON program_locations
  FOR EACH ROW EXECUTE FUNCTION program_locations_partner_same_org();

COMMENT ON COLUMN program_locations.district_id IS
  'Optional FK to the district this venue sits in (a partners row of type school_district that holds district-wide flyer rules + gatekeeper contacts). Distinct from partner_id (the owning school/org). Free-text district column is retained for district_calendars date math.';
