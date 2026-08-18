-- ANON COULD WRITE THROUGH THE PUBLIC VIEWS, BYPASSING RLS ENTIRELY.
--
-- Found 2026-08-17 while writing the migration files for the program_locations read
-- fix: reading back the LIVE grants showed the comment I had just written ("SELECT
-- only") was false. It is worse than the leak that led me here.
--
-- FOUR LINKS, all of them already true before this file:
--   1. these views are SIMPLE single-table selects, so Postgres makes them
--      AUTO-UPDATABLE - information_schema.views.is_updatable = YES;
--   2. anon and authenticated hold INSERT/UPDATE/DELETE/TRUNCATE on them. Nobody
--      granted that: the public schema's DEFAULT PRIVILEGES do it for every new
--      table and view. An explicit `grant select` is additive and changes nothing;
--   3. the views are security_invoker=false, so DML through them runs as the view
--      OWNER, not the caller;
--   4. the owner is `postgres`, which OWNS program_locations and districts, and
--      relforcerowsecurity is FALSE - and a table owner bypasses RLS unless it is
--      forced.
--
-- PROVEN, not reasoned. As role `anon` on staging, an UPDATE through
-- program_locations_public set `area` on ANOTHER provider's site row, and it
-- persisted. Probe reverted immediately; 0 rows left carrying the marker. After this
-- migration the same statement returns 42501 permission denied, which is the correct
-- failure mode (42501 = grant problem; an EMPTY result would have meant RLS).
--
-- SEVERITY, stated plainly. The read leak lets an OPERATOR SEE another provider's
-- sites. This let ANYONE HOLDING THE ANON KEY - which ships inside the frontend
-- bundle and is public by design - RENAME, RETYPE, INSERT or DELETE rows in another
-- provider's data. On prod the exposed view was districts_public (the other two
-- carried no write grants), where `district_type` is what families see on the
-- registration page. No evidence of exploitation; a hole, not an incident.
--
-- THE FIX CANNOT AFFECT READS. SELECT is untouched, and every browser path through
-- these views is a read - nothing in the app writes through a view. Writes go to the
-- base tables under the members_write_* policies, which are unchanged. Verified on
-- staging after applying: anon still reads 98 sites and 14 districts.
revoke insert, update, delete, truncate on public.program_locations_public from anon, authenticated;
revoke insert, update, delete, truncate on public.districts_public          from anon, authenticated;
revoke insert, update, delete, truncate on public.public_org_directory      from anon, authenticated;
revoke insert, update, delete, truncate on public.class_schedule_public     from anon, authenticated;

-- AND STOP IT RECURRING, which is the half that actually matters long-term.
--
-- Without this, the NEXT `create view` in the public schema inherits the same write
-- grants from default privileges, and the next person adding a safe-columns view
-- re-opens this with nothing on screen to notice it. Same shape as "CREATE OR REPLACE
-- resets reloptions": a default that silently undoes a deliberate decision.
--
-- Scoped to INSERT/UPDATE/DELETE/TRUNCATE only. SELECT stays in the defaults, because
-- new public views are supposed to be readable - it is the writes that were never
-- intended.
alter default privileges in schema public revoke insert, update, delete, truncate on tables from anon;
alter default privileges in schema public revoke insert, update, delete, truncate on tables from authenticated;

-- STILL OPEN, deliberately not changed here: these views are auto-updatable and
-- security_invoker=false, so the write path exists again the moment anyone re-grants.
-- The durable belt-and-braces would be `alter table ... force row level security` on
-- the base tables, or security_invoker=true on the views - but security_invoker=true
-- is exactly what the 14 Aug incident needed to be FALSE for signed-in parents, so it
-- cannot be flipped without re-testing that path. Raised for Jessica, not assumed.
