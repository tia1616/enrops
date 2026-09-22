-- Credits, chunk 2 prerequisite: make issuing a credit idempotent.
--
-- WHY THIS IS NOT OPTIONAL HERE. Two live Stripe webhook endpoints point at the
-- same production URL, so every event is delivered TWICE. The existing money
-- paths survive that only because each one is individually idempotent, and the
-- standing rule is that any NEW handler must be written the same way. A credit
-- is money owed; issuing it twice invents money.
--
-- A natural key will not do the job. Partial credits are legitimate - an
-- operator can credit part of a registration and refund the rest - so
-- (source_registration_id) cannot be unique. The caller supplies the key
-- instead, and the database refuses the second write rather than trusting the
-- caller to ask only once.
--
-- NULL is allowed and is NOT deduplicated: a unique index treats NULLs as
-- distinct. That is deliberate, so a future internal caller that genuinely has
-- no key is not silently blocked - but every caller that can supply one must.

alter table public.family_credits
  add column if not exists idempotency_key text;

create unique index if not exists uq_family_credits_idempotency
  on public.family_credits (idempotency_key)
  where idempotency_key is not null;

comment on column public.family_credits.idempotency_key is
  'Caller-supplied key. Unique when present; NULLs are not deduplicated. Guards against the double-delivery of the two live Stripe webhook endpoints, and against a double-clicked operator action.';
