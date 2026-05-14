-- Seed Jessica into the existing platform_admins table.
-- Run date: 2026-05-14
--
-- The platform_admins table, is_platform_admin() helper, and its RLS policies
-- were created previously (via the Supabase dashboard, not a tracked migration
-- in this repo). This migration records the seed in version control.

INSERT INTO platform_admins (auth_user_id, email, name, role)
SELECT id, 'jessica@journeytosteam.com', 'Jessica Vorster', 'superadmin'
FROM auth.users
WHERE email = 'jessica@journeytosteam.com'
ON CONFLICT (auth_user_id) DO NOTHING;
