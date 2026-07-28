-- Make the v4 section 4 refund-rate flag actually announce itself.
--
-- We shipped the flag and the Refund Watch screen but nothing that TOLD anyone
-- a crossing had happened, so the only way to learn about one was to remember
-- to open a page. Jessica, 2026-07-28: "the flag has to be linked to an actual
-- flag. email to arielle."
--
-- THROTTLE BY UNIQUE INDEX, NOT BY CODE. `period` is YYYY-MM, so the unique
-- constraint allows at most one alert per operator per calendar month and two
-- concurrent refunds cannot both send. A refund-rate crossing is sticky by
-- nature - an operator over the line stays over it for days - so alerting per
-- refund would turn a signal into noise and get the whole thing muted.

CREATE TABLE IF NOT EXISTS public.operator_flag_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- YYYY-MM. A throttle key, never displayed.
  period          text NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  context         jsonb,
  UNIQUE (organization_id, period)
);

COMMENT ON TABLE public.operator_flag_alerts IS
  'One row per internal refund-watch alert. UNIQUE(organization_id, period) is the throttle: at most one email per operator per month. v4 section 4.';

ALTER TABLE public.operator_flag_alerts ENABLE ROW LEVEL SECURITY;

-- Platform admins only, SELECT only. An operator must never be able to see
-- that they were flagged: section 4 is a prompt for us to look, not an
-- accusation to serve back to them. Writes come only from the service role in
-- the refund paths, so there is deliberately no INSERT/UPDATE/DELETE policy.
DROP POLICY IF EXISTS operator_flag_alerts_platform_read ON public.operator_flag_alerts;
CREATE POLICY operator_flag_alerts_platform_read ON public.operator_flag_alerts
  FOR SELECT USING (is_platform_admin());

GRANT SELECT ON public.operator_flag_alerts TO authenticated;

-- Recipient lives in config, never in code, so it can change without a deploy
-- and so no tenant identity is ever hardcoded in a function.
INSERT INTO public.platform_settings (key, value)
VALUES ('refund_watch_alerts', '{"enabled": true, "to": "arielle@journeytosteam.com"}'::jsonb)
ON CONFLICT (key) DO NOTHING;
