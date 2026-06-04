-- SECURITY FIX (6/4): lock the intelligence doorway to service_role only.
--
-- Supabase runs ALTER DEFAULT PRIVILEGES that auto-grants EXECUTE on every NEW
-- function in `public` directly to `anon` + `authenticated` (NOT via PUBLIC).
-- So the `revoke ... from public` in the create migration did NOT block client
-- roles — anon (unauthenticated, public key) could still call the doorway and
-- inject arbitrary events into the append-only intelligence log.
--
-- Lesson for ALL future SECURITY DEFINER functions in public: revoke from
-- anon + authenticated explicitly, not just public.

revoke execute on function public.log_enrollment_event(text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, jsonb, timestamptz, text) from public, anon, authenticated;
grant execute on function public.log_enrollment_event(text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, jsonb, timestamptz, text) to service_role;
