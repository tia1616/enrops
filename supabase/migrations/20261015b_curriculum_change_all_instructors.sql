-- The curriculum-change note goes to EVERY instructor on a class, and the
-- audit row records all of them.
--
-- 20260529 made instructor_recipient a singleton because "programs have at most
-- one confirmed instructor". Since 20261014b a class can need two, and
-- notify-program-curriculum-change now mails each eligible instructor. The
-- array lives here; instructor_recipient keeps the first result for back-compat.
-- Nothing in the app reads either column yet.
--
-- Additive, defaulted, re-runnable. Apply BEFORE deploying the function that
-- writes it, on both databases: an insert naming a missing column fails, and
-- the function only logs a failed audit insert, so the row would be lost silently.

alter table public.program_curriculum_changes
  add column if not exists instructor_recipients jsonb not null default '[]'::jsonb;

comment on column public.program_curriculum_changes.instructor_recipients is
  'Every instructor the change note was sent to (or failed for): [{instructor_id, name, email, resend_message_id, status, failure_reason}].';
comment on column public.program_curriculum_changes.instructor_recipient is
  'DEPRECATED: the first entry of instructor_recipients, kept for rows and readers from before a class could have two instructors. Read instructor_recipients.';
