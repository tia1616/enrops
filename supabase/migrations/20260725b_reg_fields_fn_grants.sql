-- Restore the DEFINER-doorway hardening that 20260725a dropped.
-- CREATE OR REPLACE on a recreated function inherits Postgres' default
-- EXECUTE TO PUBLIC, silently reversing the pattern the original definition
-- (20260710_customizable_registration_chunk0.sql) established. Not exploitable
-- today (anon already holds execute, and the function returns field DEFINITIONS
-- only — no answers, no PII), but the next person to recreate this function
-- would inherit the weaker grant.
revoke execute on function public.get_active_registration_fields(uuid, uuid) from public;
grant execute on function public.get_active_registration_fields(uuid, uuid) to anon, authenticated, service_role;
