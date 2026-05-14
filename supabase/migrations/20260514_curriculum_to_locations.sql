-- curriculum_to_locations — many-to-many between curricula and program_locations.
-- A curriculum can be offered at multiple schools/locations.
-- Run date: 2026-05-14

CREATE TABLE IF NOT EXISTS curriculum_to_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_id UUID NOT NULL REFERENCES curricula(id) ON DELETE CASCADE,
  program_location_id UUID NOT NULL REFERENCES program_locations(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (curriculum_id, program_location_id)
);

CREATE INDEX IF NOT EXISTS curriculum_to_locations_curriculum_idx ON curriculum_to_locations(curriculum_id);
CREATE INDEX IF NOT EXISTS curriculum_to_locations_location_idx ON curriculum_to_locations(program_location_id);
CREATE INDEX IF NOT EXISTS curriculum_to_locations_organization_idx ON curriculum_to_locations(organization_id);

ALTER TABLE curriculum_to_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_members_read_curriculum_locations" ON curriculum_to_locations
  FOR SELECT USING (
    organization_id IN (
      SELECT organization_id FROM org_members WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY "org_admins_write_curriculum_locations" ON curriculum_to_locations
  FOR ALL USING (
    organization_id IN (
      SELECT organization_id FROM org_members
      WHERE auth_user_id = auth.uid()
      AND role = ANY(ARRAY['owner', 'admin'])
    )
  );
