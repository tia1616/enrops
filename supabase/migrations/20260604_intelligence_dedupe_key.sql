-- Idempotency for the intelligence doorway.
-- Stripe retries webhooks, so repeatable events (payment_completed, refunded, ...)
-- carry a dedupe_key (e.g. the Stripe event id). The doorway no-ops on conflict,
-- so a retried delivery can never double-count. dedupe_key is nullable: events
-- that don't need idempotency simply pass null.

alter table intelligence.enrollment_events add column if not exists dedupe_key text;
create unique index if not exists uq_enroll_events_dedupe
  on intelligence.enrollment_events (dedupe_key) where dedupe_key is not null;

-- Signature changes (adds p_dedupe_key), so drop the old overload before recreating.
drop function if exists public.log_enrollment_event(text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, jsonb, timestamptz);

create or replace function public.log_enrollment_event(
  p_action_type     text,
  p_organization_id uuid        default null,
  p_parent_id       uuid        default null,
  p_student_id      uuid        default null,
  p_program_id      uuid        default null,
  p_camp_session_id uuid        default null,
  p_site_id         uuid        default null,
  p_registration_id uuid        default null,
  p_metadata        jsonb       default '{}'::jsonb,
  p_occurred_at     timestamptz default now(),
  p_dedupe_key      text        default null
) returns uuid
language plpgsql
security definer
set search_path = public, intelligence
as $$
declare
  v_id uuid;
begin
  insert into intelligence.enrollment_events (
    organization_id, parent_id, student_id, program_id, camp_session_id,
    site_id, registration_id, action_type, metadata, occurred_at, dedupe_key
  ) values (
    p_organization_id, p_parent_id, p_student_id, p_program_id, p_camp_session_id,
    p_site_id, p_registration_id, p_action_type, coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_occurred_at, now()), p_dedupe_key
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;
  return v_id;  -- null when a duplicate was skipped
end;
$$;

revoke all on function public.log_enrollment_event(text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, jsonb, timestamptz, text) from public;
grant execute on function public.log_enrollment_event(text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, jsonb, timestamptz, text) to service_role;
