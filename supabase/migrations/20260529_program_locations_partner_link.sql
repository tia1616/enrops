-- 20260529_program_locations_partner_link.sql
--
-- Link each program_location to (at most) one partner organisation so that
-- the operator can email camp rosters to the partner's logistics contacts
-- without re-picking recipients every time.
--
-- A partner here = school district / public school / parks_rec / community
-- org / etc. (the rows already in `partners`). One partner owns many
-- locations; one location belongs to one partner.
--
-- Linkage is intentionally optional: a location can have no partner (the
-- "Email roster" modal will prompt to pick one the first time).

ALTER TABLE program_locations
  ADD COLUMN IF NOT EXISTS partner_id UUID
    REFERENCES partners(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_program_locations_partner_id
  ON program_locations(partner_id);

-- Cross-table org integrity: a location's partner must belong to the same
-- organisation. Enforced via trigger because PG can't express it as a
-- declarative CHECK across tables.
CREATE OR REPLACE FUNCTION program_locations_partner_same_org()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  partner_org UUID;
BEGIN
  IF NEW.partner_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT organization_id INTO partner_org FROM partners WHERE id = NEW.partner_id;
  IF partner_org IS NULL THEN
    RAISE EXCEPTION 'partner % not found', NEW.partner_id;
  END IF;
  IF partner_org <> NEW.organization_id THEN
    RAISE EXCEPTION 'partner % belongs to a different organisation', NEW.partner_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_program_locations_partner_same_org ON program_locations;
CREATE TRIGGER trg_program_locations_partner_same_org
  BEFORE INSERT OR UPDATE OF partner_id, organization_id ON program_locations
  FOR EACH ROW EXECUTE FUNCTION program_locations_partner_same_org();

COMMENT ON COLUMN program_locations.partner_id IS
  'Optional FK to the partner organisation that owns this location (school district, parks_rec, etc.). Used to resolve logistics contacts when emailing rosters.';
