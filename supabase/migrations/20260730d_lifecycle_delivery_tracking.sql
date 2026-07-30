-- 20260730d — record what actually HAPPENED to a lifecycle email after Resend
-- accepted it.
--
-- WHY
-- automation_run_recipients.status answers "did we hand it to Resend" and
-- nothing more. On 2026-07-30 a grandparent said he never got his camp welcome;
-- the row said status='sent', attempts=1, no error, and there was no way to tell
-- whether Microsoft delivered it, junked it, or dropped it. The only delivery
-- evidence J2S had was open-pixel data on MARKETING sends, which is both the
-- wrong dataset and an unreliable proxy (Outlook blocks remote images).
-- marketing-resend-webhook already ingests Resend delivery events for
-- marketing_sends; this migration gives the lifecycle table somewhere to put the
-- same events.
--
-- WHY NOT REUSE status
-- automation_run_recipients_status_check allows exactly
-- ('sent','failed','skipped_unsubscribed','skipped_throttle'), and
-- lifecycle-automations-cron treats status='sent' as the terminal idempotency
-- signal — a context_key is "done" if SENT, or FAILED past MAX_SEND_ATTEMPTS.
-- Writing 'delivered'/'bounced' into that column would both violate the CHECK
-- and change which rows the cron considers already handled, which is exactly the
-- silent-miss bug class this table was built to close. Delivery state therefore
-- lives in its OWN columns and the send-state machine is left alone.
--
-- ADDITIVE + INERT: every column is nullable with no default backfill, and
-- nothing reads them yet. Existing rows and all current queries are unaffected.
-- Applied to staging and prod in the same pass (parity).

alter table public.automation_run_recipients
  add column if not exists delivery_status text,
  add column if not exists delivered_at    timestamptz,
  add column if not exists bounced_at      timestamptz,
  add column if not exists complained_at   timestamptz,
  add column if not exists bounce_detail   text;

-- Deliberately NOT a monotonic ladder mirroring marketing_sends: for a service
-- email we only care whether the mailbox provider took it, refused it, or the
-- family reported it. Opens are excluded on purpose — pixel opens are the
-- unreliable signal this whole change exists to stop relying on.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.automation_run_recipients'::regclass
      and conname  = 'automation_run_recipients_delivery_status_check'
  ) then
    alter table public.automation_run_recipients
      add constraint automation_run_recipients_delivery_status_check
      check (delivery_status is null or delivery_status in ('delivered','bounced','complained'));
  end if;
end $$;

-- The webhook's only lookup key. Partial (the column is null for every failed
-- send, and for every row written before Phase 1) so the index stays small.
create index if not exists idx_automation_run_recipients_resend_message_id
  on public.automation_run_recipients (resend_message_id)
  where resend_message_id is not null;

-- Supports the operator-facing "what didn't land" read we'll add next: bounced
-- and complained rows, newest first, scoped to one org.
create index if not exists idx_automation_run_recipients_delivery_problem
  on public.automation_run_recipients (organization_id, delivery_status, last_attempt_at desc)
  where delivery_status in ('bounced','complained');

comment on column public.automation_run_recipients.delivery_status is
  'What the mailbox provider did with an accepted send: delivered | bounced | complained. NULL = no webhook event yet (or the send never left). Written ONLY by marketing-resend-webhook. Separate from status, which tracks our own send attempt.';
comment on column public.automation_run_recipients.bounce_detail is
  'Resend bounce type/subType, e.g. "Permanent (General)". Null unless delivery_status = bounced.';
