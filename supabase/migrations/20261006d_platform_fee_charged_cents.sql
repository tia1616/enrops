-- Money doc section 9 item 14 (revenue by state): enrops never recorded the
-- fee it actually charged — only the rate config and what was refunded. This
-- is chunk one: record it going forward, at charge time, on the row that was
-- charged. See docs/handoffs/money-item14-revenue-by-state-2026-10-06.md.
--
-- Additive and inert: nullable, no backfill, no reader yet.

alter table public.registrations add column if not exists platform_fee_charged_cents integer;
alter table public.installments add column if not exists platform_fee_charged_cents integer;

comment on column public.registrations.platform_fee_charged_cents is
  'Enrops service fee actually charged on this registration''s charge, in cents. Margin only — excludes any Stripe-fee pass-through uplift a tenant''s family also covers. NULL = not recorded (predates this column, legacy no-schedule installment path, or a multi-registration charge whose per-line share could not be attributed). Money doc section 9 item 14.';
comment on column public.installments.platform_fee_charged_cents is
  'Enrops service fee actually charged on this installment row''s charge, in cents. Margin only — excludes any Stripe-fee pass-through uplift. Set only once the row is actually paid; NULL on a pending row, and on a row predating this column. Money doc section 9 item 14.';
