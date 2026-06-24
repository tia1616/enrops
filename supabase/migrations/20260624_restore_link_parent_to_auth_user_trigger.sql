-- Parity fix: re-attach the parent auto-link trigger to auth.users.
--
-- Prod has this trigger; it links a parents row to a newly created auth user by
-- email (parents.auth_id = NEW.id) so the parent can reach their dashboard. It
-- did NOT survive the staging DB clone (triggers on the Supabase-managed
-- auth.users schema don't travel in dumps), so on staging parents created an
-- auth account but were never linked. The link_parent_to_auth_user() function
-- already exists in both environments — only the trigger was missing.
--
-- CREATE OR REPLACE makes this idempotent: a no-op replace on prod (already has
-- it), the actual fix on staging. This is the linchpin for the roster → parent
-- portal invite flow.

CREATE OR REPLACE TRIGGER on_auth_user_created_link_parent
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.link_parent_to_auth_user();
