-- Widen automation_run_recipients from "lifecycle automation send log" into the
-- platform's send log, so family TRANSACTIONAL email is recorded the way
-- lifecycle email already is: the registration confirmation, the thank-you, the
-- refund receipt, the waitlist invite and lapse note, and the parent invite.
-- Today every one of those sends through Resend and writes to NO table at all
-- (verified in the source, 2026-09-07), so "was this family told, and when?" is
-- unanswerable for most of what the platform sends.
--
-- WHY WIDEN RATHER THAN MINT A SECOND LOG. Five surfaces already read this table:
-- the operator contact timeline, the delivery-issues panel, the Overview card,
-- the parent dashboard feed, and marketing-resend-webhook's delivery write-back.
-- That webhook matches a Resend event on resend_message_id ALONE -- it never
-- looks at automation_id -- so a transactional row picks up delivered / bounced /
-- complained for free. A second table means rebuilding all five.
--
-- INERT, measured on prod before writing rather than reasoned about. 1,282 rows;
-- ZERO have a null automation_id or automation_run_id, so dropping the two NOT
-- NULLs changes no existing row and the new CHECK passes on every one of them.

alter table public.automation_run_recipients
  alter column automation_run_id drop not null,
  alter column automation_id     drop not null;

-- WHAT THIS SEND WAS. Both label sites resolve a row's display name by joining
-- automation_id -> automations -> automation_templates.display_name. With a null
-- automation_id they fall through to a literal -- "Automated email" on the
-- operator timeline, "Update" on the parent dashboard -- which would render a
-- refund receipt and a registration confirmation identically. `source` names the
-- kind of send (and is the dedupe discriminator below); `label` is the operator-
-- facing sentence, stored rather than derived so the log still reads correctly if
-- the wording later changes.
alter table public.automation_run_recipients
  add column if not exists source text,
  add column if not exists label  text;

-- A row is EITHER an automation send (both ids present, no source) OR a sourced
-- transactional send (no automation, source names it). This forbids the
-- half-populated row that neither label site could name.
alter table public.automation_run_recipients
  add constraint automation_run_recipients_origin_ck check (
    (automation_id is not null and automation_run_id is not null and source is null)
    or
    (automation_id is null and source is not null)
  );

-- DEDUPE -- and the shape here is load-bearing, so the reasoning is recorded.
--
-- automation_run_recipients_unique_send, UNIQUE (automation_id, context_key), is
-- DELIBERATELY LEFT EXACTLY AS IT IS. It is lifecycle-automations-cron's
-- idempotency key: index.ts:731 upserts with onConflict "automation_id,
-- context_key". Postgres will not accept a PARTIAL unique index as an ON CONFLICT
-- arbiter unless the statement repeats the index predicate, and PostgREST cannot
-- emit one -- so "replace it with a partial index WHERE automation_id IS NOT
-- NULL", which is the obvious move and the one this work was scoped to make,
-- would break that upsert on the very next cron run. Worse, the write is only
-- console.error'd (index.ts:735), so the emails would keep going out and would
-- silently stop being logged: the exact defect this migration exists to close.
--
-- Nothing needs replacing anyway. Unique indexes are NULLS DISTINCT by default,
-- so a transactional row (automation_id null) is never constrained by it, and
-- automation rows keep the identical guarantee they have today.
--
-- Transactional rows get their own key, or a retried Stripe webhook logs the same
-- receipt twice. NON-partial on purpose, for the same arbiter reason as above, so
-- the new writers can upsert through PostgREST. Automation rows have source null
-- and are therefore unconstrained by it. Both halves of that were proved on the
-- live database inside rolled-back transactions before this was written: two
-- source-null rows sharing (org, context_key) both insert, and a second
-- source-not-null row with the same key IS refused.
create unique index if not exists automation_run_recipients_unique_transactional
  on public.automation_run_recipients (organization_id, source, context_key);

comment on column public.automation_run_recipients.source is
  'Null for a lifecycle automation send (automation_id names it). Otherwise the transactional send type, e.g. registration_confirmation / refund_receipt / waitlist_invite -- both the label basis and the dedupe discriminator.';
comment on column public.automation_run_recipients.label is
  'Operator-facing name for a transactional send, stored at write time. Null for automation rows, which are labelled from automation_templates.display_name.';
