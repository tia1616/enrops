-- One request for every class's session dates, instead of one request per class.
--
-- The staffing board and the admin home both resolved session dates by firing
-- derive_program_session_dates() once per class from the BROWSER. Measured on
-- prod 2026-09-07: for Journey to STEAM's 33 staffable FA26 classes the whole
-- job costs 44.7 ms of database time (EXPLAIN ANALYZE, 1.35 ms per class). The
-- database was never the problem. The cost was 33 separate HTTPS round-trips,
-- which a browser runs about six at a time.
--
-- So this is not a faster calculation, it is the same calculation asked for in
-- one question. It CALLS the existing function rather than reimplementing it:
-- session-date truth (calendars, closures, early release, session_count) stays
-- in exactly one place, and a change there cannot leave this copy behind.
--
-- SECURITY. Deliberately INVOKER, not DEFINER, and deliberately selecting FROM
-- public.programs rather than iterating the caller's id array. programs has RLS
-- enabled with three policies, so a caller only ever gets back the classes they
-- could already read: passing another tenant's ids returns no rows for them,
-- and the org scope is enforced by the database rather than asserted by the
-- screen. The inner function is likewise invoker-rights and STABLE.
--
-- GRANTS are NARROWER than the single-row function on purpose. That one is
-- granted to PUBLIC and anon because public catalogue pages call it; this one
-- is only ever called by two admin screens, so it starts at authenticated +
-- service_role. Nothing depends on it yet, so tightening now costs nothing and
-- avoids handing anonymous callers a way to ask about many ids in one request.
-- Note that `revoke ... from public` does NOT remove anon's own grant, so anon
-- is revoked explicitly and proacl is read back after this runs.

create or replace function public.derive_program_session_dates_bulk(p_program_ids uuid[])
returns table (program_id uuid, session_dates date[])
language sql
stable
as $$
  select p.id, public.derive_program_session_dates(p.id)
  from public.programs p
  where p.id = any(p_program_ids)
$$;

comment on function public.derive_program_session_dates_bulk(uuid[]) is
  'Bulk twin of derive_program_session_dates: one round-trip for many classes. Calls that function per row so the date logic lives in one place. INVOKER + reads through programs RLS, so callers only get classes they can already see.';

revoke all on function public.derive_program_session_dates_bulk(uuid[]) from public;
revoke all on function public.derive_program_session_dates_bulk(uuid[]) from anon;
grant execute on function public.derive_program_session_dates_bulk(uuid[]) to authenticated;
grant execute on function public.derive_program_session_dates_bulk(uuid[]) to service_role;
