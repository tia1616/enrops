-- Early fraud warnings: one row per warning Stripe sends us
-- (radar.early_fraud_warning.created).
--
-- WHY THIS EXISTS. An early fraud warning means the CARDHOLDER'S BANK has
-- reported a charge as fraud. It is the step before a chargeback: on the Hen
-- charge (Oct 2026) the warning arrived and the 10.4 dispute followed 5.4 hours
-- later. Until a dispute is filed the charge can still be refunded, and a call
-- to the family often stops it entirely - but only if the operator hears about
-- it the same day. Before this, nothing in enrops listened for the event; the
-- Peterson warning (Nov 2026) reached J2S only because Stripe emailed the
-- platform account and someone forwarded it a day later.
--
-- WHAT THE ROW IS FOR: it is the CLAIM that makes the operator alert send
-- exactly once. Stripe retries webhooks, and two endpoints point at
-- stripe-webhook, so one warning can arrive more than once. The webhook inserts
-- here FIRST; a 23505 on stripe_warning_id means another delivery already
-- alerted and this one stops. If the alert email then fails, the webhook
-- deletes its claim and returns 500 so Stripe's retry gets another go.
--
-- Written only by the service role. No app surface reads it yet, so no grant to
-- anon or authenticated (and, per the 2026-10-30 Supabase change, new tables get
-- no automatic grants - service_role is granted explicitly below).

CREATE TABLE IF NOT EXISTS public.fraud_warnings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  stripe_warning_id         text NOT NULL UNIQUE,
  stripe_charge_id          text,
  stripe_payment_intent_id  text,
  -- Account the charge lived on. NULL = the platform (destination charge).
  stripe_charge_account_id  text,
  registration_id           uuid REFERENCES public.registrations(id) ON DELETE SET NULL,
  -- Stripe's vocabulary, stored verbatim (e.g. 'unauthorized_use_of_card').
  fraud_type                text,
  warned_at                 timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fraud_warnings_org_idx
  ON public.fraud_warnings (organization_id, warned_at DESC);

COMMENT ON TABLE public.fraud_warnings IS
  'One row per Stripe early fraud warning. The row is the claim that makes the operator alert send once; written only by stripe-webhook.';

ALTER TABLE public.fraud_warnings ENABLE ROW LEVEL SECURITY;

-- No policies on purpose: only the service role touches this table.
REVOKE ALL ON public.fraud_warnings FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.fraud_warnings TO service_role;
