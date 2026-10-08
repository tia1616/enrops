-- The business's follow-up email after a final payment notice.
--
-- Jessica 2026-10-08: when the last automatic retry fails, the family is told to
-- put a new card on by a deadline, and the business gets one more email five
-- days after that final notice (the morning after the family's deadline) so it
-- can decide whether to release the spot. _shared/declineRetry.ts owns the days.
--
-- provider_followup_on  the day process-installments sends that email. Set ONLY
--                       after the family's final email actually went out, so
--                       "we told them" in the business's email is always true.
--                       NULL = nothing booked. Additive and inert: every
--                       existing row is NULL.

alter table public.installments
  add column if not exists provider_followup_on date;

comment on column public.installments.provider_followup_on is
  'Day process-installments emails the business that a family missed its final-notice deadline. NULL = none booked.';

create index if not exists installments_provider_followup_on_idx
  on public.installments (provider_followup_on)
  where status = 'paused_card_failed' and provider_followup_on is not null;
