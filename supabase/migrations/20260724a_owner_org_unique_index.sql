-- One-owner-org invariant: back the provision RPC's "already owns an org?" check
-- with a real constraint (Registration MVP P0 hardening).
--
-- provision_operator_org() (migration 20260723d) guards against a caller owning a
-- second org by SELECTing their existing owner membership before inserting. That
-- check is a read-then-write with no backing constraint, so two concurrent calls
-- (double-clicked signup, retried request) can BOTH pass the SELECT and BOTH
-- insert — creating two orgs for one owner (TOCTOU). This partial unique index
-- makes the second insert fail atomically at the DB, closing the race.
--
-- Semantics match the RPC's check EXACTLY: uniqueness on auth_user_id among rows
-- where role='owner'. A user may still be a non-owner member (staff/admin/viewer)
-- of other orgs — only owner-membership is capped at one.
--
-- Additive + inert: verified on both staging (mumfymlapolsfdnpewci) and prod
-- (iuasfpztkmrtagivlhtj) that NO auth_user_id currently owns more than one org, so
-- the index builds cleanly with no backfill/dedupe. Applied to staging first, then
-- prod in the same release pass (parity).

CREATE UNIQUE INDEX IF NOT EXISTS org_members_one_owner_org_per_user
  ON public.org_members (auth_user_id)
  WHERE role = 'owner';

COMMENT ON INDEX public.org_members_one_owner_org_per_user IS
  'Enforces one owner-membership per auth user (one owned org per account). Backs provision_operator_org() against the concurrent-signup TOCTOU. Non-owner memberships are unconstrained.';
