-- Drop vestigial, unused instructor pay-rate columns from organizations.
--
-- These were added + seeded 2026-05-26 (20260526_organizations_pay_rate_columns.sql
-- / 20260526_seed_j2s_pay_rates_from_policy_2025.sql) for an hourly pay-calc model
-- that was never wired up. The live pay scheme is flat per-day (camps) / per-session
-- (afterschool) and never reads org pay_* columns.
--
-- They were also a money read-leak: organizations.members_read_own_org is gated on
-- is_org_member (any role), so a viewer/staff member could read an instructor pay
-- rate (e.g. pay_hourly_cents = $20/hr) via direct PostgREST. Removing the dead
-- columns closes that leak and removes schema cruft.
--
-- Verified 2026-06-30: zero references in src/, supabase/functions/, and DB functions.
-- If a future tenant needs hourly instructor pay, re-introduce as a can_handle_money
-- gated config (build-when-triggered). Seeded J2S values ($20/hr, $100 weekly bonus,
-- 3h morning / 7h full-day) are preserved in the 20260526 migration files.
--
-- Applied to staging (mumfymlapolsfdnpewci) + prod (iuasfpztkmrtagivlhtj) via MCP
-- on 2026-06-30; this file is the repo record for parity.

ALTER TABLE public.organizations
  DROP COLUMN IF EXISTS pay_hourly_cents,
  DROP COLUMN IF EXISTS pay_camp_weekly_bonus_cents,
  DROP COLUMN IF EXISTS pay_camp_morning_hours,
  DROP COLUMN IF EXISTS pay_camp_full_day_hours;
