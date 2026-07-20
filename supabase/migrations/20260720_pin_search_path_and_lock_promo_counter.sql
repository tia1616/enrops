-- 2026-07-20 security audit follow-up (approved by Jessica).
-- Two housekeeping fixes from docs/handoffs/security-audit-2026-07-20.md.
--
-- ALTER FUNCTION is used deliberately instead of CREATE OR REPLACE:
-- duplicate_program's body has been amended by three migrations
--   20260716_duplicate_program.sql                        (create)
--   20260717_deprecate_programs_sessions_legacy_column.sql (drop legacy `sessions`)
--   20260717_program_schedule_mode_preserve_in_duplicate.sql (preserve schedule_mode)
-- Re-declaring the body here would risk silently reverting those seam fixes.
-- ALTER pins the setting only and leaves prosrc byte-identical (verified by
-- md5(prosrc) before/after on staging: 82694ac586202fe9de9724fa96e0bdd5).

-- 1) duplicate_program: pin search_path.
--    Runs SECURITY INVOKER, so RLS on `programs`
--    (members_write_programs = can_edit_org(organization_id)) remains the real gate.
--    KEEPS `authenticated` EXECUTE -- the live caller is an admin browser RPC at
--    src/pages/admin/programs/ProgramsCalendar.jsx:203. Do NOT revoke it.
alter function public.duplicate_program(uuid, text) set search_path = public;

-- 2) increment_promo_used_count: pin search_path AND finish the lockdown that
--    migration 20260712_increment_promo_used_count.sql intended.
--    That migration ran `revoke all ... from public`, which does NOT remove the
--    Supabase default privileges granted directly to anon + authenticated --
--    so both still held EXECUTE. Same gotcha as 20260604.
--    Both real callers use the SERVICE_ROLE key, so this is non-breaking:
--      supabase/functions/create-checkout/index.ts:145  (guardAdmin)
--      supabase/functions/stripe-webhook/index.ts:175   (admin)
alter function public.increment_promo_used_count(uuid) set search_path = public;
revoke execute on function public.increment_promo_used_count(uuid) from public, anon, authenticated;
grant  execute on function public.increment_promo_used_count(uuid) to service_role;

-- Staging verification (2026-07-20), runtime not just static:
--   increment_promo_used_count as authenticated -> denied 42501            PASS
--   increment_promo_used_count as service_role  -> executed               PASS
--   duplicate_program as real org admin JWT     -> copied row, term=SP27  PASS
--   duplicate_program body hash unchanged; programs count 98 -> 98        PASS
--   staging security advisor: both search_path warnings cleared           PASS
