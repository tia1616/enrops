-- Tell enrops when we could not return our margin to an operator.
--
-- On 2026-09-08 three fee returns failed because the platform Stripe balance
-- was too low: $3.71 and $2.40 to Journey to STEAM, $1.01 to The Ukulele
-- Project. Nothing retried them and NOTHING TOLD ANYONE. They were found two
-- days later only because somebody thought to run a query, and settled by hand.
-- Jessica, 2026-09-10: "how can we make sure i receive the alert for a failed
-- fee return?"
--
-- WHY THE THROTTLE IS PER REFUND AND NOT PER MONTH, which is where this
-- deliberately diverges from its sibling operator_flag_alerts. A refund-rate
-- crossing is STICKY - an operator over the line stays over it for days - so
-- that table throttles to one email per operator per month to stop a signal
-- becoming noise. A margin shortfall is the opposite: each one is a DISCRETE
-- DEBT with its own amount and its own Stripe object to go and refund. Monthly
-- throttling would have reported one of 2026-09-08's three and silently hidden
-- $3.41 of the $7.12. So the unique key is the refund row: every shortfall is
-- announced exactly once, and a webhook redelivery cannot double-send.
--
-- NO EM DASHES.

CREATE TABLE IF NOT EXISTS public.margin_shortfall_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The throttle. One alert per refund, forever.
  refund_id       uuid NOT NULL REFERENCES public.refunds(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- What we owed at the moment we alerted. Recorded because the refunds row can
  -- later be settled by hand (as all three of 2026-09-08's were), and then the
  -- alert would be unfalsifiable without this.
  owed_cents      integer NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  context         jsonb,
  UNIQUE (refund_id)
);

COMMENT ON TABLE public.margin_shortfall_alerts IS
  'One row per internal alert about an enrops margin we failed to return to an operator. UNIQUE(refund_id) is the throttle: every shortfall announced exactly once, unlike operator_flag_alerts which throttles monthly.';

ALTER TABLE public.margin_shortfall_alerts ENABLE ROW LEVEL SECURITY;

-- Platform admins only, SELECT only. An OPERATOR must never read this: the
-- whole point of removing the shortfall from the refund response on 2026-09-08
-- was that enrops's cash position is not their business and they cannot act on
-- it. Writes come only from the service role in the two refund paths, so there
-- is deliberately no INSERT/UPDATE/DELETE policy.
DROP POLICY IF EXISTS margin_shortfall_alerts_platform_read ON public.margin_shortfall_alerts;
CREATE POLICY margin_shortfall_alerts_platform_read ON public.margin_shortfall_alerts
  FOR SELECT USING (is_platform_admin());

-- REVOKE BY NAME, not just from PUBLIC. Prod carries ALTER DEFAULT PRIVILEGES
-- that hand `authenticated` ALL on new public tables, and a revoke from PUBLIC
-- does not remove a grant held directly by a role. That exact gap put a write
-- verb on program_locations_public for every signed-in parent. Read proacl back
-- after applying.
REVOKE ALL ON TABLE public.margin_shortfall_alerts FROM public;
REVOKE ALL ON TABLE public.margin_shortfall_alerts FROM anon;
REVOKE ALL ON TABLE public.margin_shortfall_alerts FROM authenticated;
GRANT SELECT ON TABLE public.margin_shortfall_alerts TO authenticated;

-- Recipient lives in config, never in code, so it can change without a deploy
-- and no tenant identity is hardcoded in a function. This one goes to whoever
-- settles the platform Stripe balance, which is NOT the refund_watch_alerts
-- recipient: that channel is the refund-RATE flag and it goes to Arielle.
INSERT INTO public.platform_settings (key, value)
VALUES ('margin_shortfall_alerts', '{"enabled": true, "to": "jessica@journeytosteam.com"}'::jsonb)
ON CONFLICT (key) DO NOTHING;
