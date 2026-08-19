-- registrations.status must always have a value.
--
-- WHY THIS IS A CONSTRAINT AND NOT SEVEN QUERY EDITS.
--
-- Adding status='waitlist' meant every reader that means "enrolled" had to exclude it,
-- and the fix was `.neq('status','waitlist')` in seven places. That emits
-- `status <> 'waitlist'`, which in SQL is NULL - not TRUE - for a row whose status is
-- NULL. PostgREST drops those rows. So each of those seven readers silently stopped
-- returning blank-status registrations, and two of them are load-bearing:
-- RosterEditor feeds the roster list AND the roster email, so the failure mode is a
-- child who is in the room and missing from the sheet the instructor carries.
--
-- The column has had DEFAULT 'pending' since the beginning and there is not one NULL on
-- either database (prod 660 rows, staging 142, both zero). So the blank status was never
-- a real state - just a hole the schema left open. Closing the hole makes the whole class
-- of bug unreachable, which is better than patching seven predicates and hoping the
-- eighth reader remembers.
--
-- registrations_status_check does NOT cover this: a CHECK constraint passes on NULL,
-- because it only fails on FALSE. That is why the existing check never caught it.
--
-- SAFE TO APPLY: zero violating rows on both environments, and a DEFAULT already exists,
-- so any INSERT that omits status keeps working exactly as before. Verified immediately
-- before applying rather than recalled.

alter table public.registrations
  alter column status set not null;

comment on column public.registrations.status is
  'confirmed / pending / cancelled / refunded / waitlist (registrations_status_check). NOT NULL since 2026-08-19: a NULL status made `status <> ''waitlist''` evaluate to NULL rather than TRUE, so every reader that excluded waitlist rows silently dropped blank-status rows too - including the one feeding the roster email. DEFAULT ''pending'' means inserts that omit it are unaffected.';
