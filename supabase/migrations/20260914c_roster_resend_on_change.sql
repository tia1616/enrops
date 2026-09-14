-- Record WHICH CHILDREN were on the roster we sent a school, so the partner-roster
-- automation can tell that their copy has gone stale.
--
-- WHY. Until now a school got a roster at most twice - seven days before day one
-- and the morning of - and never again. A child who enrolled in week two or left
-- in week four never reached the list the school takes attendance from.
--
-- WHY A SET OF IDS AND NOT A TIMESTAMP. There is no `updated_at` on either
-- `registrations` or `students`; there is only `registered_at` and `cancelled_at`.
-- A family who abandons checkout and pays two days later joins the roster with
-- `registered_at` still stamped when the pending row was created - BEFORE the last
-- send - so a timestamp comparison silently misses exactly the case that happens
-- most. Membership is derived from payment state, so comparing the membership set
-- catches it.
--
-- ADDITIVE AND EMPTY, DELIBERATELY NOT BACKFILLED. Every roster sent before this
-- migration genuinely has no record of who was on it, and NULL is the truthful
-- value for that. The automation reads NULL as "we cannot say their copy is
-- wrong" and stays quiet, which is what stops the first cron run after deploy
-- from emailing every school we have ever sent a roster to. Each class arms
-- itself the next time a roster is sent for it, by any route including a manual
-- send from the class page.
--
-- Applied to staging and prod in the same pass.

alter table public.roster_email_sends
  add column if not exists roster_student_ids uuid[];

comment on column public.roster_email_sends.roster_student_ids is
  'Sorted, de-duplicated student ids on the roster at send time. The partner_roster automation compares this with the current roster to decide whether the school''s copy has gone stale. NULL means the send predates 2026-09-14 and cannot be compared; the automation treats NULL as "do not send".';

-- No GRANT or RLS change. The column is added to a table that already has row
-- security enabled and a SELECT policy for org members, and column-level grants
-- are not in use here, so the new column inherits the table's existing access.
