-- Automatic retries for a declined payment-plan charge.
--
-- Until now a decline paused the plan (status = 'paused_card_failed') and
-- nothing ever tried it again unless the family put a new card on. The policy
-- Arielle signed off on 2026-10-07 retries a declined card on day 3 and day 7,
-- then stops; supabase/functions/_shared/declineRetry.ts owns the rules.
--
-- Four columns, all additive and inert: every existing row gets 0 / null, which
-- means "no retry booked", so nothing already paused starts charging because of
-- this migration. Only a decline that happens AFTER the new charger ships books
-- a retry.
--
--   card_decline_count       declines that DEFINITELY did not charge, over the
--                            row's life. Never reset. It is the suffix on the
--                            Stripe idempotency key, so each attempt after a
--                            decline is a new request rather than a replay of
--                            the old decline.
--   retry_payment_method_id  the card the current retry cycle is for. A
--                            different card on the row (the family replaced it)
--                            starts a fresh cycle with its own retries.
--   card_retries_done        automatic retries attempted on that card.
--   next_retry_on            the day the charger will try again. NULL = no
--                            automatic retry is booked. Same calendar (UTC) as
--                            due_date.
--
-- The charger only retries a row whose registration is still 'confirmed', so a
-- family the business removed while their plan was paused is never charged.

alter table public.installments
  add column if not exists card_decline_count integer not null default 0,
  add column if not exists retry_payment_method_id text,
  add column if not exists card_retries_done smallint not null default 0,
  add column if not exists next_retry_on date;

alter table public.installments
  drop constraint if exists installments_card_decline_count_nonneg,
  add constraint installments_card_decline_count_nonneg check (card_decline_count >= 0),
  drop constraint if exists installments_card_retries_done_nonneg,
  add constraint installments_card_retries_done_nonneg check (card_retries_done >= 0);

comment on column public.installments.card_decline_count is
  'Declines that definitely did not charge, over the row''s life. Suffix on the Stripe idempotency key. Never reset.';
comment on column public.installments.retry_payment_method_id is
  'Card the current automatic-retry cycle is for. A different card on the row starts a new cycle.';
comment on column public.installments.card_retries_done is
  'Automatic retries attempted on retry_payment_method_id.';
comment on column public.installments.next_retry_on is
  'Day process-installments retries this declined row. NULL = no retry booked.';

-- The charger looks these up every day; a partial index keeps that to the
-- handful of rows actually waiting on a retry.
create index if not exists installments_next_retry_on_idx
  on public.installments (next_retry_on)
  where status = 'paused_card_failed' and next_retry_on is not null;
