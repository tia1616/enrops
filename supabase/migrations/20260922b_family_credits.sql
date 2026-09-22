-- Credits, chunk 1: the ledger. Money layer section 6.
--
-- Nothing writes to these tables yet. They are additive and empty on both
-- environments, so this migration changes nothing a family or an operator can
-- see until the issuing chunk lands.
--
-- WHAT A CREDIT IS HERE. Section 6: "A credit is money owed, not revenue."
-- A credit is created when a class goes away and the family's money stays with
-- the business. The DEFAULTS are the doc's and are settled (2026-09-22):
--   - the FAMILY cancels     -> credit is the default, where the business's
--                               cancellation policy allows it
--   - the BUSINESS cancels   -> the family chooses, and REFUND is the default
--                               if they do not choose
-- Those are not arbitrary. An enrops credit is ILLIQUID in a way a marketplace
-- credit is not: a family cannot spend it today, only at next term's
-- registration or at a camp that happens to run near them, and they are bound
-- to their own school. Prod bears this out - 199 of 263 J2S families (76%)
-- appear in exactly ONE term, so for three families in four a credit is money
-- they may never spend. Refund-as-default protects them.
--
-- WHY TWO TABLES. A single row with a mutable `remaining_cents` cannot answer
-- "where did this family's money go", which is the only question that matters
-- when money is owed. Movements are recorded, and the balance is DERIVED from
-- them, so a balance can never quietly disagree with its own history - the
-- same "one number, one place" rule that the fee layer is built on.

-- ---------------------------------------------------------------------------
-- THE CREDIT
-- ---------------------------------------------------------------------------
create table if not exists public.family_credits (
  id                uuid primary key default gen_random_uuid(),

  -- KEYED ON THE ORGANISATION AND THE PARENT TOGETHER, never the parent alone.
  -- `parents` has no organization_id - a parent row is global and
  -- `parent_org_relationships` is the join - and on production TEN parents have
  -- children at two different organisations. A credit keyed on the parent would
  -- let a family spend a J2S credit at another business, which is one operator
  -- paying another operator's refund.
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  parent_id         uuid not null references public.parents(id)       on delete cascade,

  -- What was issued. Never changes after creation; spending and cashing out are
  -- movements, not edits to this number.
  amount_cents      integer not null,

  -- 'active'   - some or all of it is still available
  -- 'spent'    - fully applied to registrations
  -- 'refunded' - the family took the money back instead (cash out, or the
  --              refund default on a business cancellation)
  -- 'void'     - issued in error and withdrawn; kept, never deleted, because a
  --              ledger that loses rows is not a ledger
  status            text not null default 'active',

  -- Why it exists. Drives the copy the family sees, and lets the money page
  -- separate "we cancelled on them" from "they changed their mind".
  reason            text not null,

  -- The registration whose cancellation created it. Nullable and ON DELETE SET
  -- NULL on purpose: the money outlives the enrollment record.
  source_registration_id uuid references public.registrations(id) on delete set null,

  -- ALWAYS NULL. Section 6: "No expiration on any credit." The column exists so
  -- that introducing an expiry is a visible, deliberate migration rather than a
  -- quiet default someone adds later.
  expires_at        timestamptz,

  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint family_credits_amount_positive check (amount_cents > 0),
  constraint family_credits_status_known
    check (status in ('active', 'spent', 'refunded', 'void')),
  constraint family_credits_reason_known
    check (reason in ('business_cancelled', 'family_cancelled', 'goodwill', 'overpayment'))
);

-- The balance read is "what does this family have available at this business",
-- which is active rows only.
create index if not exists idx_family_credits_org_parent_active
  on public.family_credits (organization_id, parent_id)
  where status = 'active';

create index if not exists idx_family_credits_org_created
  on public.family_credits (organization_id, created_at desc);

alter table public.family_credits enable row level security;

-- READ, operator side: money, so owner/admin only - the same bar as the rest of
-- the money surfaces. `can_handle_money` is byte-identical to `can_admin_org`
-- today; it is used here because it NAMES the money bar, so if that bar ever
-- moves, credits move with it instead of being missed.
drop policy if exists money_read_family_credits on public.family_credits;
create policy money_read_family_credits
  on public.family_credits for select
  using (can_handle_money(organization_id) or is_platform_admin());

-- READ, family side: a parent sees their own credits and nobody else's.
-- Section 6 requires credits to show on the family's account and receipt.
-- Mirrors `parents_see_own_regs` on registrations exactly.
drop policy if exists parents_read_own_credits on public.family_credits;
create policy parents_read_own_credits
  on public.family_credits for select
  using (parent_id = current_parent_id());

-- NO WRITE POLICY, deliberately. Credits are issued by the cancellation path
-- and spent at checkout, both with the service key. A ledger a browser can
-- write to is not a ledger.

-- GRANTS, separately from RLS and revoked BY NAME first. Grants fail before RLS
-- (42501), `revoke from public` does not remove anon's own privileges, and
-- PRODUCTION carries an ALTER DEFAULT PRIVILEGES rule granting ALL on new
-- tables to `authenticated` that staging does not have. The scholarship fund
-- migration hit exactly this and ended up with different grants on the two
-- environments from one file, caught only by reading the ACL back.
revoke all on table public.family_credits from public;
revoke all on table public.family_credits from anon;
revoke all on table public.family_credits from authenticated;
grant select on table public.family_credits to authenticated;
grant all    on table public.family_credits to service_role;

-- ---------------------------------------------------------------------------
-- WHAT HAPPENED TO IT
-- ---------------------------------------------------------------------------
create table if not exists public.family_credit_movements (
  id              uuid primary key default gen_random_uuid(),
  credit_id       uuid not null references public.family_credits(id) on delete cascade,

  -- Carried on the row rather than joined through the credit so the RLS policy
  -- is a direct comparison, matching how every other org-scoped table here
  -- filters. A join in a policy is a second place for tenancy to go wrong.
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- Always POSITIVE: the kind says which direction it moves, so a sign error
  -- cannot silently inflate a balance.
  amount_cents    integer not null,

  -- 'applied'  - spent against a registration at checkout
  -- 'refunded' - paid back to the family's original payment method
  -- 'adjusted' - an operator correction, which is why `note` matters
  kind            text not null,

  -- Set for 'applied'. Null for the others.
  registration_id uuid references public.registrations(id) on delete set null,

  note            text,
  created_at      timestamptz not null default now(),

  constraint family_credit_movements_amount_positive check (amount_cents > 0),
  constraint family_credit_movements_kind_known
    check (kind in ('applied', 'refunded', 'adjusted'))
);

create index if not exists idx_family_credit_movements_credit
  on public.family_credit_movements (credit_id, created_at);

create index if not exists idx_family_credit_movements_registration
  on public.family_credit_movements (registration_id)
  where registration_id is not null;

alter table public.family_credit_movements enable row level security;

drop policy if exists money_read_credit_movements on public.family_credit_movements;
create policy money_read_credit_movements
  on public.family_credit_movements for select
  using (can_handle_money(organization_id) or is_platform_admin());

-- A parent can see the history of their OWN credits, and only through the
-- credit they own - the subquery is the tenancy proof, not an assumption.
drop policy if exists parents_read_own_credit_movements on public.family_credit_movements;
create policy parents_read_own_credit_movements
  on public.family_credit_movements for select
  using (
    exists (
      select 1 from public.family_credits c
      where c.id = family_credit_movements.credit_id
        and c.parent_id = current_parent_id()
    )
  );

revoke all on table public.family_credit_movements from public;
revoke all on table public.family_credit_movements from anon;
revoke all on table public.family_credit_movements from authenticated;
grant select on table public.family_credit_movements to authenticated;
grant all    on table public.family_credit_movements to service_role;
