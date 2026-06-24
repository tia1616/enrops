-- RBAC: drop the stray 'instructor' value from the org_members role CHECK.
-- Decision (Jessica, 2026-06-24): instructors only use their portal; 'instructor'
-- is not an operator tier. Verified 0 org_members rows use it on staging + prod.
ALTER TABLE public.org_members DROP CONSTRAINT IF EXISTS org_members_role_check;
ALTER TABLE public.org_members ADD CONSTRAINT org_members_role_check
  CHECK (role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'viewer'::text]));
