-- program_locations_public handed anon AND authenticated full write, and the view
-- is security_invoker=false, so a write through it runs as the view OWNER and the
-- base table's RLS is never evaluated.
--
-- PROVED on production 2026-09-04, inside rolled-back transactions, with a control:
--   as anon, UPDATE public.program_locations        (the TABLE) -> 0 rows  (RLS refuses)
--   as anon, UPDATE public.program_locations_public (the VIEW)  -> 1 ROW  (RLS bypassed)
-- 90 site rows, every tenant, and DELETE/TRUNCATE were granted too. `authenticated`
-- held the same grants, and parents sign in, so the reachable population was not
-- only anonymous visitors.
--
-- This is what 20260817d ("revoke anon writes on EVERY public view, not four by
-- name") was written to prevent. That migration was never merged - it sits on the
-- abandoned branch feat/sites-leak and is in neither environment's ledger. Its
-- sibling districts_public WAS revoked on prod (20260818c), so the decision was
-- taken, applied for districts, and missed here.
--
-- STAGING ALREADY HAD THE CORRECT GRANTS (anon: SELECT/REFERENCES/TRIGGER only),
-- so this is a no-op there and exists to make the two ledgers agree.
--
-- SELECT is deliberately KEPT: this view IS the public catalogue, and families
-- have to be able to find a school before they can register at it. Verified after
-- the revoke on prod: an anonymous read still returns all 90 sites.
--
-- Revoked from anon and authenticated BY NAME as well as from PUBLIC, because
-- `revoke ... from public` does NOT remove a grant held directly by anon.
--
-- Applied to BOTH databases 2026-09-04; read back on both, and the ACL is now
-- byte-identical: {postgres=arwdDxtm,anon=rxtm,authenticated=rxtm,service_role=arwdDxtm}.

revoke insert, update, delete, truncate on public.program_locations_public from anon;
revoke insert, update, delete, truncate on public.program_locations_public from authenticated;
revoke insert, update, delete, truncate on public.program_locations_public from public;
