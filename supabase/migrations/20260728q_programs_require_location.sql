-- Every program must have a location.
--
-- Why: the location picker was optional, so a program could go live with
-- nowhere to be -- and an operator with no locations saw an empty dropdown with
-- nothing to pick and no way to add one from where they stood. Requiring the
-- field deletes that dead end rather than papering over it with a tooltip.
-- Families see the location at registration, on the receipt and in reminders,
-- so "no specific location" was never really a valid answer.
--
-- Safety, verified against the live databases before writing this:
--   * PROD has 92 programs and ZERO without a location, so steps 1 and 2 are
--     no-ops there and step 3 cannot fail. No backfill, no grandfathering.
--   * STAGING has 6 without one, all synthetic test rows across 5 orgs; two of
--     those orgs have no locations at all, which is why step 1 exists.
--   * The FK programs_program_location_id_fkey is ON DELETE NO ACTION, so
--     deleting an in-use location ALREADY fails. NOT NULL adds no new hazard.
--   * Write paths that can set this column: QuickProgramBuilder (now requires
--     it), ProgramWizardNew (already required it), and duplicate_program()
--     (copies it from the source row). No edge function inserts programs.
--
-- Idempotent: re-running is a no-op once every program has a location.

-- 1. An org can only be given a location if it has one. Orgs that have a
--    location-less program but no locations at all get a single placeholder so
--    step 2 has something to point at. Named plainly because a human will see
--    it and should be able to rename it. slug is NOT NULL and globally unique,
--    so it is derived from the org id rather than the name.
insert into program_locations (organization_id, name, slug)
select distinct p.organization_id,
       'Main location',
       'main-location-' || substr(md5(p.organization_id::text), 1, 8)
from programs p
where p.program_location_id is null
  and p.organization_id is not null
  and not exists (
    select 1 from program_locations l
    where l.organization_id = p.organization_id
      and l.archived = false
  );

-- 2. Point every location-less program at its OWN org's oldest active location.
--    Scoped by organization_id on both sides -- a program must never inherit
--    another tenant's venue.
update programs p
set program_location_id = (
  select l.id
  from program_locations l
  where l.organization_id = p.organization_id
    and l.archived = false
  order by l.created_at nulls last, l.name
  limit 1
)
where p.program_location_id is null;

-- 3. Enforce it in the database, not only in the UI. The forms block an empty
--    location, but a form is not a guarantee -- this is.
alter table programs
  alter column program_location_id set not null;
