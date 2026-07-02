-- Intelligence layer, part 2: PLATFORM-USAGE events (what operators do across the
-- whole app — not just enrollment). Sealed & append-only, same seam as
-- enrollment_events (docs/moat/INTELLIGENCE_LAYER_RULES.md). Captured entirely
-- server-side: edge functions call public.log_platform_event(); pure client-side
-- table writes are captured by SECURITY DEFINER triggers (below / in siblings).
-- No front-end code involved.

create table if not exists intelligence.platform_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid,             -- operator scope; NO FK (log survives operational deletes)
  actor_user_id   uuid,             -- auth.users id of who did it (nullable; system/cron = null)
  feature         text not null,    -- e.g. scheduling | campaigns | rosters | ... (see taxonomy)
  action          text not null,    -- e.g. offer_sent | program_published | roster_imported
  outcome         text not null default 'success',  -- success | fail
  metadata        jsonb not null default '{}'::jsonb,  -- IDs + facts ONLY, never PII
  occurred_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  dedupe_key      text
);

comment on table intelligence.platform_events is
  'One row per operator platform action (feature + action + outcome). Sealed/append-only like enrollment_events; written only via public.log_platform_event() or SECURITY DEFINER triggers. Answers what operators use / do not use / where it fails.';

create index if not exists idx_platform_events_org_feature_time
  on intelligence.platform_events (organization_id, feature, occurred_at desc);
create index if not exists idx_platform_events_feature_action
  on intelligence.platform_events (feature, action, outcome);
create unique index if not exists uq_platform_events_dedupe
  on intelligence.platform_events (dedupe_key) where dedupe_key is not null;

alter table intelligence.platform_events enable row level security;
-- Intentionally NO policies: sealed schema, no client grants (same as enrollment_events).

-- THE DOORWAY: single controlled write path public -> intelligence for usage events.
create or replace function public.log_platform_event(
  p_feature         text,
  p_action          text,
  p_outcome         text        default 'success',
  p_organization_id uuid        default null,
  p_actor_user_id   uuid        default null,
  p_metadata        jsonb       default '{}'::jsonb,
  p_occurred_at     timestamptz default null,
  p_dedupe_key      text        default null
) returns uuid
language plpgsql
security definer
set search_path = public, intelligence
as $$
declare
  v_id uuid;
begin
  insert into intelligence.platform_events (
    organization_id, actor_user_id, feature, action, outcome, metadata, occurred_at, dedupe_key
  ) values (
    p_organization_id, p_actor_user_id, p_feature, p_action, coalesce(p_outcome, 'success'),
    coalesce(p_metadata, '{}'::jsonb), coalesce(p_occurred_at, now()), p_dedupe_key
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;
  return v_id;
exception when others then
  -- Fail-safe: telemetry must NEVER break an operational path.
  return null;
end;
$$;

revoke all on function public.log_platform_event(text, text, text, uuid, uuid, jsonb, timestamptz, text) from public, anon, authenticated;
grant execute on function public.log_platform_event(text, text, text, uuid, uuid, jsonb, timestamptz, text) to service_role;

comment on function public.log_platform_event is
  'Doorway for platform-usage events. service_role only (edge fns). SECURITY DEFINER triggers call it as owner. Fail-safe: never throws.';
