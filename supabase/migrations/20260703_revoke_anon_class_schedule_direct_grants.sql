-- Tighten anon access to public.class_schedule (staging + prod same pass).
--
-- 20260702_create_class_schedule.sql granted anon the full set of direct table
-- privileges (select, insert, update, delete, references, trigger, truncate).
-- That is too broad: anon must never touch this table directly. The intended
-- anon-safe read surface is the SECURITY DEFINER view public.class_schedule_public
-- (see 20260702_class_schedule_portal_read_access.sql), which projects only safe
-- columns for publicly-listed orgs.
--
-- Two vectors to close:
--   1. Direct table privileges on public.class_schedule for anon.
--   2. Write privileges on the view public.class_schedule_public itself. The view
--      is a simple, auto-updatable, NON-security_invoker view (runs with owner
--      rights, bypassing the base table's RLS). Supabase's default privileges had
--      silently granted anon insert/update/delete/truncate on the view — so anon
--      could WRITE into class_schedule *through* the view, bypassing RLS. The view
--      is meant to be SELECT-only.
--
-- Because class_schedule_public runs with its owner's rights (not security_invoker),
-- revoking anon's direct table privileges does NOT break public reads through the
-- view. authenticated + service_role keep their table access; the view stays
-- SELECT-only for both anon and authenticated (they never write via the view).

-- (1) Strip all direct table privileges from anon on the base table.
revoke all privileges on public.class_schedule from anon;

-- (2) Lock the public projection view down to SELECT-only for the public roles.
revoke all privileges on public.class_schedule_public from anon;
revoke all privileges on public.class_schedule_public from authenticated;
grant select on public.class_schedule_public to anon, authenticated;
