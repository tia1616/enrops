-- Intelligence layer: append-only platform telemetry, sealed from the operational (public) schema.
--
-- THE SEAM:
--   * Operational code reaches intelligence ONLY through public.log_enrollment_event().
--   * The intelligence schema is never exposed to the REST API.
--   * No role is granted UPDATE/DELETE, so the history of what happened is immutable —
--     even to the code that writes it.
--
-- This is the "future intelligence" half of the database. The "operational" half stays in public.
-- The two never bleed into each other except through the single doorway below.

create schema if not exists intelligence;
revoke all on schema intelligence from public;

create table if not exists intelligence.enrollment_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid,             -- operator scope; NO FK on purpose (log survives operational deletes)
  parent_id       uuid,
  student_id      uuid,
  program_id      uuid,             -- afterschool instance
  camp_session_id uuid,             -- camp instance
  site_id         uuid,             -- program_location
  registration_id uuid,
  action_type     text not null,    -- open vocabulary: initiated | payment_completed |
                                     -- waitlist_added | waitlist_converted | cancelled | refunded | ...
  metadata        jsonb not null default '{}'::jsonb,  -- event-specific payload; new signals need NO migration
  occurred_at     timestamptz not null default now(),  -- when the thing happened
  created_at      timestamptz not null default now()   -- when the row was written
);

comment on schema intelligence is
  'Append-only platform telemetry for future predictive intelligence. Sealed from the operational public schema; written only via public.log_enrollment_event(). No UPDATE/DELETE granted — history is immutable.';
comment on table intelligence.enrollment_events is
  'One row per enrollment-funnel event. Open action_type vocabulary + jsonb metadata so new signals need no migration. No FKs by design — this is an immutable log, not relational operational data.';

create index if not exists idx_enroll_events_org_action_time
  on intelligence.enrollment_events (organization_id, action_type, occurred_at desc);
create index if not exists idx_enroll_events_parent
  on intelligence.enrollment_events (parent_id);
create index if not exists idx_enroll_events_registration
  on intelligence.enrollment_events (registration_id);

alter table intelligence.enrollment_events enable row level security;
-- Intentionally NO policies: the schema is unexposed and no client role has grants,
-- so anon/authenticated cannot reach it at all. service_role writes only via the doorway below.

-- THE DOORWAY: the single controlled write path from operational (public) -> intelligence.
-- SECURITY DEFINER so it inserts as the owner; callers never touch the intelligence schema directly.
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
  p_occurred_at     timestamptz default now()
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
    site_id, registration_id, action_type, metadata, occurred_at
  ) values (
    p_organization_id, p_parent_id, p_student_id, p_program_id, p_camp_session_id,
    p_site_id, p_registration_id, p_action_type, coalesce(p_metadata, '{}'::jsonb), coalesce(p_occurred_at, now())
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Lock the doorway: only server-side (service_role) code may log events. No client role can.
revoke all on function public.log_enrollment_event(text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, jsonb, timestamptz) from public;
grant execute on function public.log_enrollment_event(text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, jsonb, timestamptz) to service_role;
