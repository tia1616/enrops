-- Scholarship fund, chunk 1: the config a provider sets, and the ledger of gifts
-- families give at checkout.
--
-- WHY TWO TABLES AND NOT COLUMNS ON `organizations`:
--   `organizations` is already wide, is read by dozens of callers, and is
--   surfaced to anon through a deliberately narrow view (`public_org_directory`,
--   hardened 2026-06-25). Adding family-facing copy there would mean widening
--   that view - the exact "narrow/widen a column allowlist" class that took
--   School calendar down for seven days. Nothing anon reads is touched here:
--   the registration page gets this config through the org-fee-config edge
--   function, which is already the sanctioned service-role path for "the anon
--   register flow needs an org setting the anon view does not carry".
--
-- WHY A DEDICATED LEDGER AND NOT A `registrations` ROW:
--   A gift is not an enrollment. Every reader of `registrations` means "a child
--   in a class" - rosters, capacity, payroll, attendance, the refund path that
--   sums `amount_cents` per payment intent. A $25 gift wearing a registration's
--   clothes would land in all of them.

-- ---------------------------------------------------------------------------
-- CONFIG
-- ---------------------------------------------------------------------------
create table if not exists public.org_scholarship_fund (
  organization_id   uuid primary key references public.organizations(id) on delete cascade,
  -- OFF until a provider deliberately turns it on. A donation ask that appears
  -- on a tenant's checkout because a migration defaulted it to true is money
  -- solicited in their name without their say-so.
  enabled           boolean not null default false,
  headline          text    not null default 'Help another family join',
  blurb             text    not null default 'Your gift goes to our scholarship fund, which lowers the cost of a spot for a family who needs it.',
  -- Suggested tiles, in cents. Order is the display order.
  preset_amounts_cents integer[] not null default array[500, 1000, 2500, 5000],
  min_cents         integer not null default 100,
  max_cents         integer not null default 500000,
  -- Whether the "add a bit to cover processing" box is ticked by default.
  cover_fee_default boolean not null default true,
  -- The rate that box adds, as a fraction. ONE number, read by BOTH the browser
  -- (through org-fee-config) and create-checkout, so the figure the family is
  -- shown and the figure Stripe charges cannot drift. Deliberately NOT derived
  -- from estimateStripeFee: that helper models a whole charge including the flat
  -- 30c, and a gift riding along on an existing charge does not add a second one.
  cover_fee_pct     numeric not null default 0.029,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- Bounds have to hold as a pair, or the UI has nothing coherent to render.
  constraint org_scholarship_fund_bounds_sane
    check (min_cents > 0 and max_cents >= min_cents),
  constraint org_scholarship_fund_cover_pct_sane
    check (cover_fee_pct >= 0 and cover_fee_pct <= 0.2)
);

alter table public.org_scholarship_fund enable row level security;

-- READ: any member of the org (a viewer setting up copy needs to see it).
-- WRITE: admin+ only. This decides whether families are asked for money and how
-- much - the same bar as the other money settings, not the bar for editing a
-- class description.
drop policy if exists members_read_org_scholarship_fund on public.org_scholarship_fund;
create policy members_read_org_scholarship_fund
  on public.org_scholarship_fund for select
  using (is_org_member(organization_id) or is_platform_admin());

drop policy if exists admins_write_org_scholarship_fund on public.org_scholarship_fund;
create policy admins_write_org_scholarship_fund
  on public.org_scholarship_fund for all
  using (can_admin_org(organization_id) or is_platform_admin())
  with check (can_admin_org(organization_id) or is_platform_admin());

-- GRANTS separately from RLS: grants fail FIRST (42501), and `revoke from
-- public` does not remove anon's own privileges. anon never reads this table
-- directly - org-fee-config serves it with the service key.
-- `authenticated` is revoked BY NAME before being granted back, not just left
-- to the explicit grant below. PROD carries an ALTER DEFAULT PRIVILEGES rule
-- that grants ALL on new tables to `authenticated`; staging does not. Applying
-- the first draft of this file gave prod's authenticated role INSERT/UPDATE/
-- DELETE on both tables while staging got SELECT only - two environments, same
-- migration, different grants, caught only by reading relacl back.
revoke all on table public.org_scholarship_fund from public;
revoke all on table public.org_scholarship_fund from anon;
revoke all on table public.org_scholarship_fund from authenticated;
grant select, insert, update, delete on table public.org_scholarship_fund to authenticated;
grant all on table public.org_scholarship_fund to service_role;

-- ---------------------------------------------------------------------------
-- LEDGER
-- ---------------------------------------------------------------------------
create table if not exists public.donations (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,

  -- What the FUND receives. This is the number that belongs in "we raised X".
  gift_cents        integer not null,
  -- What the donor added on top so processing does not come out of the gift.
  -- Zero when they declined the box, or when the provider turned it off.
  covered_fee_cents integer not null default 0,
  -- What Stripe actually charged for the gift line. Generated, never written,
  -- so the receipt figure and the ledger figure cannot disagree.
  charged_cents     integer generated always as (gift_cents + covered_fee_cents) stored,

  -- 'pending'    - session created, family has not finished paying
  -- 'processing' - ACH accepted, not yet cleared
  -- 'paid'       - money is in
  -- 'failed'     - the bank transfer bounced, or the session expired unpaid
  status            text not null default 'pending',

  -- How the gift arrived. Only 'checkout' exists in chunk 1; a standalone
  -- /donate page and a parent-dashboard ask are separate sources later, and
  -- the reporting question "where do gifts come from" needs this from day one.
  source            text not null default 'checkout',

  donor_email       text,
  donor_name        text,
  -- Set once the family has an account. Null for a first-time donor: the parent
  -- row is created by the webhook AFTER this row exists.
  parent_id         uuid references public.parents(id) on delete set null,

  -- The registrations this gift rode along with. Plain uuid[] with no FK, the
  -- same shape the Stripe metadata already carries - a gift must not be deleted
  -- or blocked because a registration was.
  registration_ids  uuid[] not null default '{}'::uuid[],

  stripe_checkout_session_id text,
  stripe_payment_intent_id   text,
  -- Which account the charge lives on: null for a destination org (platform),
  -- the connected account id for a direct org. Mirrors registrations, and it is
  -- what a later refund would need to scope its Stripe call.
  stripe_charge_account_id   text,

  created_at        timestamptz not null default now(),
  paid_at           timestamptz,

  constraint donations_gift_positive       check (gift_cents > 0),
  constraint donations_covered_nonnegative check (covered_fee_cents >= 0),
  constraint donations_status_known
    check (status in ('pending', 'processing', 'paid', 'failed'))
);

-- One gift per checkout session. The webhook can fire more than once for the
-- same session (Stripe retries, and completed + async_payment_succeeded both
-- land for ACH), so the settle step has to be an UPDATE of a known row rather
-- than an insert that could double-count the fund.
create unique index if not exists uq_donations_session
  on public.donations (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

create index if not exists idx_donations_org_created
  on public.donations (organization_id, created_at desc);
-- The reporting read is "what has this fund actually taken in", which is paid
-- rows only; a partial index keeps pending/failed noise out of it.
create index if not exists idx_donations_org_paid
  on public.donations (organization_id, paid_at desc)
  where status = 'paid';

alter table public.donations enable row level security;

-- READ: money, so admin+ only - the same bar as the rest of the money surfaces
-- (see the RBAC money-read rule). Rows carry donor email addresses.
-- WRITE: nobody through the API. create-checkout and stripe-webhook write with
-- the service key. A ledger a browser can insert into is not a ledger.
drop policy if exists admins_read_donations on public.donations;
create policy admins_read_donations
  on public.donations for select
  using (can_admin_org(organization_id) or is_platform_admin());

-- Same revoke-by-name for `authenticated` as the config table above, and for
-- the same prod-only default-privileges reason. A ledger the browser role can
-- INSERT into is only as safe as the absence of a permissive policy.
revoke all on table public.donations from public;
revoke all on table public.donations from anon;
revoke all on table public.donations from authenticated;
grant select on table public.donations to authenticated;
grant all    on table public.donations to service_role;
