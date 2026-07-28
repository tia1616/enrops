-- Arielle's v4 section 8, items 3 and 4: the founding-operator review ask and
-- the operator referral ask, fired off a clean refund.
--
-- HER PREMISE WAS THAT THESE ALREADY EXIST. They do not. Every row in
-- automation_templates has audience 'families', 'instructors' or 'partners' -
-- that system is a per-tenant tool for an OPERATOR to email THEIR families.
-- There is no enrops-to-operator channel, so there was nothing to hook into.
-- The nearest existing template, review_request, runs the other way: it asks a
-- FAMILY to review the OPERATOR.
--
-- This table is the whole new mechanism: one row per (org, ask) the moment we
-- send it. Insert-once IS the idempotency - a 23505 means "already asked", so
-- no operator can be asked twice even if a refund webhook is redelivered.

CREATE TABLE IF NOT EXISTS public.operator_growth_asks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  ask_key          text NOT NULL CHECK (ask_key = ANY (ARRAY['review'::text, 'referral'::text])),
  sent_at          timestamptz NOT NULL DEFAULT now(),
  -- What triggered it, for reporting. Never used to decide anything.
  trigger_context  jsonb,
  UNIQUE (organization_id, ask_key)
);

COMMENT ON TABLE public.operator_growth_asks IS
  'One row per growth ask sent to an OPERATOR (enrops -> operator). UNIQUE(organization_id, ask_key) makes asking twice impossible. v4 section 8 items 3-4.';

ALTER TABLE public.operator_growth_asks ENABLE ROW LEVEL SECURITY;

-- Platform-only. An operator has no reason to read or write their own ask log,
-- and letting them would leak how the growth triggers work.
DROP POLICY IF EXISTS operator_growth_asks_platform_read ON public.operator_growth_asks;
CREATE POLICY operator_growth_asks_platform_read ON public.operator_growth_asks
  FOR SELECT USING (is_platform_admin());

GRANT SELECT ON public.operator_growth_asks TO authenticated;

-- Thresholds live in the DB next to the refund-watch settings, so the cadence
-- can be tuned without a deploy. 'review_after_clean_refunds' = 1 means the
-- first clean refund; 'referral_after_clean_refunds' = 3 because a refund
-- CYCLE reasonably means it has worked more than once. Both are guesses at
-- Arielle's intent and are meant to be changed. enabled=false: nothing reaches
-- a real operator until it is deliberately switched on.
INSERT INTO public.platform_settings (key, value)
VALUES ('operator_growth_asks', jsonb_build_object(
  'review_after_clean_refunds',   1,
  'referral_after_clean_refunds', 3,
  'enabled',                      false
))
ON CONFLICT (key) DO NOTHING;
