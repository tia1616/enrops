-- 2026-07-20 — code-review follow-up to
-- 20260720_pin_search_path_and_lock_promo_counter.sql (same day, same session).
--
-- WHY THIS EXISTS: that migration pinned `search_path = public`, which is
-- INCOMPLETE. When pg_temp is not named explicitly, Postgres implicitly
-- searches it FIRST -- so a caller could still shadow `programs` /
-- `promo_codes` with a same-named temp table and have the function operate on
-- the decoy. That is the exact attack the pin is meant to prevent, so the
-- original fix did not fully close the hole it targeted.
--
-- Naming pg_temp LAST forces it to be searched last. This matches the dominant
-- convention already in the database (can_edit_org, can_admin_org,
-- derive_program_session_dates, district_calendar_key, cron_unschedule_by_name,
-- check_program_assignment_conflict, compute_range_session_count, ~14 total).
--
-- Kept as a separate migration rather than amending the first one so the git
-- record matches what actually ran on staging, in order.
--
-- NOTE: bare ALTER (no `if exists` guard) is deliberate for a security
-- migration -- if the function is missing, this should fail loudly rather than
-- silently skip and leave the hardening unapplied.

alter function public.duplicate_program(uuid, text)    set search_path = public, pg_temp;
alter function public.increment_promo_used_count(uuid) set search_path = public, pg_temp;

-- Staging verification (2026-07-20), runtime not static:
--   increment_promo_used_count as authenticated -> denied 42501            PASS
--   increment_promo_used_count as service_role  -> executed                PASS
--   duplicate_program as real org-admin JWT     -> copied row, term=SU27   PASS
--   SHADOWING PROOF: created a decoy `pg_temp.promo_codes` seeded to 999,
--     called the function as service_role, decoy still 999 -> the function
--     hit public.promo_codes, not the decoy                                PASS
--   body hashes unchanged (82694ac.../6207963e...); programs 98 -> 98      PASS
--
-- PRE-EXISTING, NOT FIXED HERE (backlog): these were pinned with bare
-- `search_path = public` by earlier migrations and carry the same weakness --
-- apply_term_early_bird, check_org_access, compute_distance_bonus,
-- check_camp_assignment_conflict, auto_add_registrant_to_marketing_list.
-- Out of scope for this audit follow-up; raise separately.
