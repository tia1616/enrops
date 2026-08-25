-- 20260825d_public_read_program_locations_anon_only.sql
--
-- THIS IS THE MIGRATION THAT CLOSES THE LEAK. Everything before it was
-- additive. Do not apply this to an environment until 20260825b, 20260825c AND
-- the frontend half are all on it - this is the only subtractive step, and the
-- three things it depends on are what stop it breaking live surfaces.
--
-- THE DEFECT. public_read_program_locations was created `TO public`, which
-- includes `authenticated`. Postgres ORs permissive policies, so it overrode the
-- org-scoped members_read_program_locations sitting beside it: any SIGNED-IN
-- user could read every active provider's sites, cross-tenant. Parents are not
-- org_members, so "signed-in user" means every family with a dashboard.
--
-- Measured on PROD 2026-08-25, before the fix:
--   89 rows readable across 3 providers
--   55 with a school contact phone
--   53 with an arrival/dismissal briefing
--    9 with a room number
--    5 with private operator notes
--    0 with contact_email or contact_name  <- unpopulated today. That is LUCK,
--      not a control: `authenticated` held SELECT on all 24 columns including
--      both, so the next operator to fill one in would have published it.
--
-- Same defect, same shape, same file family as districts: 20260813c/d. The
-- lesson did not transfer to the table next to it, which is why the comment in
-- 20260806d predicting "if a future caller needs column-level enforcement, that
-- wants a view, not a wider policy" is now this change.
--
-- WHY `TO anon` AND NOT A NARROWER GRANT. Column grants are per-ROLE, and an
-- operator, a parent and an instructor are all `authenticated`; Postgres cannot
-- tell them apart, so narrowing the grant to protect parents would have
-- revoked contact_phone from the operator whose own site it is. The full
-- argument, with the four reads it would have 42501'd, is in 20260825b's header.
--
-- WHAT EACH ROLE GETS AFTER THIS:
--   anon           -> this policy, still narrowed by the base table's COLUMN
--                     allowlist (9 columns; no contact_*, no notes, no
--                     room_number, no arrival/dismissal). Unchanged behaviour.
--   authenticated  -> NO cross-tenant read. Rows now come only from a policy
--                     that names a real relationship:
--                       members_read_program_locations      own org, all columns
--                       parents_read_enrolled_locations     sites their child is registered at
--                       instructors_read_assigned_locations sites they are offered / teach
--                     plus program_locations_public for the catalogue,
--                     registration, the availability form and pay history.
--   service_role   -> untouched. Edge functions never consulted RLS.
--
-- THE COLUMN GRANT ON `authenticated` IS LEFT ALONE, ON PURPOSE. It still
-- covers all 24 columns, because operators legitimately read all 24 of their
-- own org's rows and that is now the only way they reach them. The control
-- moved to the row predicate. A future reader tempted to "finish the job" by
-- revoking columns here should read 20260825b first.
--
-- DROP-THEN-CREATE rather than ALTER POLICY ... TO, because `alter policy` can
-- change the roles but this file should read as the whole final definition -
-- 20260627 already used `alter policy` on this same policy to change its USING
-- clause, and reconstructing the current state then meant reading two files.
-- The USING clause below is character-for-character what is on both databases
-- today (verified 2026-08-25); only the role list changes.
--
-- A GAP THIS DOES NOT CLOSE, stated so nobody reads this as complete: `anon`
-- can still enumerate the 9 allowlisted columns - names, addresses, slugs - of
-- every ACTIVE org's sites. public_org_directory is `organizations WHERE status
-- = 'active'`, not a curated opt-in-to-a-catalogue set, so an org that has not
-- published anything is still listed. School names and street addresses are
-- public information and the catalogue needs them, so this is deliberate, not
-- an oversight - but it is a real cross-tenant read and a future "is the
-- catalogue opt-in?" decision belongs on public_org_directory, not here.

drop policy if exists public_read_program_locations on public.program_locations;
create policy public_read_program_locations
  on public.program_locations
  for select
  to anon
  using (
    organization_id in (
      select public_org_directory.id from public.public_org_directory
    )
  );
