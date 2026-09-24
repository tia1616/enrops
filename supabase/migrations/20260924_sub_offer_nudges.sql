-- Chase a sub class-day nobody has answered.
--
-- Jessica, 2026-09-24, after sending 10 real offers across 2 class-days and
-- asking the right question: how will she know if nobody replies? Today nothing
-- chases. The day sits in the calm "offers out" state until it arrives, and
-- silence looks exactly like progress.
--
-- Her schedule, and her reasoning, which is sound: chase the people who can
-- SOLVE it first and only interrupt the provider if that did not work.
--   T-8 instructors, T-7 provider, T-4 instructors, T-3 provider.
-- The timings live in _shared/subNudgeStages.ts, which has the tests. This file
-- only stores WHAT WAS SENT.
--
-- SHIPPED DARK. organizations.sub_nudges_enabled defaults FALSE, so applying
-- this to production sends nothing to anybody until somebody flips one row. The
-- flip is the go-live and it is reversible.

-- ─────────────────────────────────────────── what has already been chased ──
-- One row per (class-day, stage). The UNIQUE index below is the idempotence
-- guarantee, not the code: two cron runs in the same minute, or a retry after a
-- timeout, cannot both claim a stage. The row is written BEFORE the emails go
-- and updated with the outcome afterwards, so a crash mid-send leaves a claimed
-- row that says so rather than a silent duplicate send.
create table if not exists public.sub_offer_nudges (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  parent_assignment_id   uuid not null,
  parent_assignment_type text not null check (parent_assignment_type in ('camp','program')),
  date                   date not null,
  stage                  text not null check (stage in
                           ('instructor_1','provider_1','instructor_2','provider_2')),
  recipients             int  not null default 0,
  error_text             text,
  created_at             timestamptz not null default now(),
  completed_at           timestamptz
);

create unique index if not exists sub_offer_nudges_one_per_stage
  on public.sub_offer_nudges (parent_assignment_id, parent_assignment_type, date, stage);

comment on table public.sub_offer_nudges is
  'One row per sub class-day per nudge stage. Claimed BEFORE the emails are sent '
  'so a retry cannot double-send; completed_at and recipients record what actually '
  'went. A row with completed_at null and error_text set is a stage that was '
  'claimed and failed - it will not be retried, because its threshold has passed.';

create index if not exists sub_offer_nudges_org_date
  on public.sub_offer_nudges (organization_id, date);

alter table public.sub_offer_nudges enable row level security;

-- Readable by the org it belongs to, so a "we chased them on the 1st" line can
-- be shown in the product later. Only service_role writes: the cron is the one
-- writer and no client should be able to fake a nudge record.
drop policy if exists sub_offer_nudges_org_read on public.sub_offer_nudges;
create policy sub_offer_nudges_org_read on public.sub_offer_nudges
  for select using (is_org_member(organization_id) or is_platform_admin());

revoke all on public.sub_offer_nudges from anon;
grant select on public.sub_offer_nudges to authenticated;

-- ──────────────────────────────────────────────────── the go-live switch ──
-- FALSE everywhere on purpose. Applying this migration changes nothing that any
-- instructor or provider can see; flipping one organisation's row is the
-- deliberate, reversible go-live.
alter table public.organizations
  add column if not exists sub_nudges_enabled boolean not null default false;

comment on column public.organizations.sub_nudges_enabled is
  'When true, sub-offer-nudges-cron may email this org''s instructors and its '
  'alert_email about class-days nobody has answered. Default FALSE so the '
  'feature ships dark and each tenant is switched on deliberately.';
