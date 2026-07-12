-- Promo redemptions ledger (chunk 6 foundation).
--
-- One row each time a promo code is actually redeemed at a completed checkout.
-- Purposes:
--   1. Idempotent used_count counting — the webhook can fire more than once for a
--      payment; unique(promo_code_id, redemption_key) makes a re-delivery a no-op.
--   2. Per-family limit enforcement — count rows by (promo_code_id, parent_id).
--   3. An auditable record of who redeemed what and how much was discounted.
--
-- redemption_key = the Stripe payment_intent id for a paid checkout, or
-- 'comp:<registration_id>' for a $0 comp/scholarship checkout that skips Stripe.
--
-- Additive + inert: nothing reads or writes this yet. Staging now; prod at the
-- gated charge-path release on Jessica's go.

create table if not exists promo_redemptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  promo_code_id uuid not null references promo_codes(id) on delete cascade,
  parent_id uuid references parents(id) on delete set null,
  redemption_key text not null,
  amount_discounted_cents integer,
  created_at timestamptz not null default now(),
  unique (promo_code_id, redemption_key)
);

create index if not exists idx_promo_redemptions_code on promo_redemptions (promo_code_id);
create index if not exists idx_promo_redemptions_org on promo_redemptions (organization_id);
create index if not exists idx_promo_redemptions_parent on promo_redemptions (promo_code_id, parent_id);

alter table promo_redemptions enable row level security;

-- Org members can read their own redemptions (for a future admin view).
-- Writes come from service-role edge functions (webhook), which bypass RLS —
-- no write policy is granted to app roles on purpose.
create policy members_read_promo_redemptions on promo_redemptions
  for select using (is_org_member(organization_id) or is_platform_admin());
