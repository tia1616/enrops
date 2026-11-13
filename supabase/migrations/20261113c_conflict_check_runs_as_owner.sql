-- "Lock in draft" timed out on WI27 (2026-11-13): 35 rows, one UPDATE, as the
-- signed-in owner -> "canceling statement due to statement timeout".
--
-- MEASURED on prod, each inside a rolled-back transaction:
--   as the owner's JWT (authenticated)   35 rows   12,531 ms   (limit 8,000)
--   as postgres                          35 rows      270 ms
--   derive_program_session_dates x60     user 3,335 ms vs owner 60 ms
-- The conflict trigger walks session dates for the class AND every same-weekday
-- class the instructor holds (20261027a). Run as the caller, every read inside
-- that walk (sites, district calendars, skipped dates) re-evaluates the
-- member / public-directory / parent / instructor read policies row by row -
-- ~55x the work, for answers that are identical, because an org admin can see
-- every row of their own org anyway.
--
-- FIX: the trigger runs as its owner. It is a guard that must see EVERY clash
-- (a read policy hiding a row would let a double-booking through), it only
-- reads and raises, and a function returning `trigger` cannot be called through
-- the API. Proven in the same rolled-back transaction: 35 rows in 262 ms, and a
-- real same-time clash attempted as the signed-in user is still refused.
--
-- EXECUTE is revoked from public/anon/authenticated: a trigger function's
-- EXECUTE right is checked when the trigger is CREATED, not when it fires
-- (proven on staging 2026-11-02, see 20261102a), so writes are unaffected.
-- search_path is already pinned to public, pg_temp.

alter function public.check_program_assignment_conflict() security definer;
revoke execute on function public.check_program_assignment_conflict() from public, anon, authenticated;
