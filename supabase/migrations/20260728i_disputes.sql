-- Arielle's v4 section 5, item 2: "Optionally surface dispute status inside the
-- Enrops dashboard (read-only ...) so operators don't have to check two places."
--
-- READ-ONLY BY DESIGN. Enrops never responds to a dispute, never uploads
-- evidence, and never decides one. This table is a mirror of what Stripe tells
-- us so an operator sees it where they already work. Every row is written by
-- the webhook; nothing in the app writes here.
--
-- WHO ACTUALLY PAYS depends on the charge model, and the UI has to say so
-- rather than imply the operator is always on the hook:
--   DIRECT charge  -> the dispute amount AND Stripe's ~$15 dispute fee come out
--                     of the OPERATOR's balance. Verified on staging with a real
--                     test-mode dispute: operator -2500 with a 1500 fee, net
--                     -4000; the platform balance was untouched.
--   DESTINATION    -> Stripe debits the PLATFORM, "with or without
--                     on_behalf_of". So Enrops carries J2S's disputes, and will
--                     for as long as J2S stays on destination charges, which is
--                     permanently. Section 5's "nothing to build" was written
--                     believing the opposite.
-- borne_by records which of those applied, so nobody has to re-derive it later.

CREATE TABLE IF NOT EXISTS public.disputes (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  stripe_dispute_id         text NOT NULL UNIQUE,
  stripe_charge_id          text,
  stripe_payment_intent_id  text,
  -- Account the disputed charge lived on. NULL = the platform.
  stripe_charge_account_id  text,
  registration_id           uuid REFERENCES public.registrations(id) ON DELETE SET NULL,
  amount_cents              integer NOT NULL DEFAULT 0,
  currency                  text NOT NULL DEFAULT 'usd',
  reason                    text,
  -- Stripe's own status vocabulary, stored verbatim. Not re-mapped here: the
  -- UI maps it to plain English at the point of display, so a new Stripe status
  -- shows up raw rather than being silently swallowed by a stale CHECK.
  status                    text NOT NULL,
  borne_by                  text NOT NULL DEFAULT 'unknown'
                              CHECK (borne_by = ANY (ARRAY['operator'::text,'platform'::text,'unknown'::text])),
  evidence_due_at           timestamptz,
  opened_at                 timestamptz,
  closed_at                 timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS disputes_org_idx ON public.disputes (organization_id, opened_at DESC);

COMMENT ON TABLE public.disputes IS
  'Read-only mirror of Stripe disputes so operators see them without a second dashboard. v4 section 5. borne_by says whose balance Stripe actually debits: operator on direct charges, platform on destination.';

ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;

-- Same money-read gate as refunds: this exposes charge amounts and outcomes.
DROP POLICY IF EXISTS disputes_org_money_read ON public.disputes;
CREATE POLICY disputes_org_money_read ON public.disputes
  FOR SELECT USING (can_handle_money(organization_id) OR is_platform_admin());

-- No INSERT/UPDATE/DELETE policy on purpose. Only the service role (the
-- webhook) writes here; there is no app path that should ever create a dispute.
GRANT SELECT ON public.disputes TO authenticated;
