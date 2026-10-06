-- Phase 2 of the J2S review flow (ops manual section 10, "Reviews: the two-
-- step system that gets us to 4.9"). Phase 1 (live) sends a "how was it"
-- email whose star links go straight to a Squarespace page that reads
-- ?score= and ?p= from the URL with no server-side record of who tapped
-- what. Phase 2 moves the TAP itself into enrops: a public, HMAC-token-
-- gated endpoint records the score against the registration that earned it,
-- then redirects to the SAME Squarespace page (nothing about what a family
-- sees changes) — so a low score can notify the operator immediately
-- instead of waiting for her to read a support@ inbox, and a 48-hour
-- "haven't reviewed yet" reminder to 5-star families stops being a thing
-- nobody is doing by hand.
--
-- ONE ROW PER REGISTRATION (not per family) — review_request already treats
-- "one ask, whichever registration surfaced it" as the unit for a family in
-- a given year; scoring continues that unit. A family with two children in
-- the window gets two separate asks' worth of registration rows if both are
-- eventually scored (each via its own token), never one row fighting over
-- two scores.
create table public.program_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  registration_id uuid not null references registrations(id),
  score smallint not null check (score between 1 and 5),
  submitted_at timestamptz not null default now(),
  -- Set when the family's own click on "Leave a Google review" was recorded
  -- (a SEPARATE enrops-side tracking redirect, not the Squarespace page
  -- itself — that page is outside enrops' visibility). NULL = no click yet,
  -- which is exactly what the 48-hour reminder checks for.
  google_click_at timestamptz,
  -- Set once the 48-hour reminder has been sent to a 5-star family with no
  -- click yet, so the cron never sends it twice ("Then stop" — ops manual).
  reminder_sent_at timestamptz,
  -- Set once the immediate operator notification has fired for a 1-2 score,
  -- for the same reason — this table IS the idempotency key, not a flag on
  -- the registration.
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  -- One registration, one score. A re-tap (the family clicks a different
  -- star after already scoring) UPDATEs this row rather than creating a
  -- second one — see the edge function's upsert.
  unique (registration_id)
);

comment on table public.program_reviews is
  'One row per scored registration from the Phase-2 /review-rate flow (ops manual section 10). Written only by the review-rate edge function (service role); read by the admin reviews view and the 48h-reminder + low-score-notification cron logic.';

create index program_reviews_org_idx on public.program_reviews (organization_id);
-- Reminder-cron scan: 5-star, no click yet, not yet reminded. Partial index
-- keeps this cheap regardless of table size — most rows never match it once
-- reminded or clicked.
create index program_reviews_reminder_due_idx on public.program_reviews (submitted_at)
  where score = 5 and google_click_at is null and reminder_sent_at is null;

alter table public.program_reviews enable row level security;

-- Mirrors marketing_sends' own policy shape exactly (check_org_access, not
-- can_edit_org — any accepted org member can see send/review history, not
-- just owners/admins). No INSERT/UPDATE/DELETE policy for authenticated:
-- every write goes through the edge function under service_role, which
-- bypasses RLS entirely.
create policy org_read_program_reviews on public.program_reviews
  for select
  using (check_org_access(organization_id));
