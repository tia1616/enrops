-- Per-tenant instructor pay rate card.
--
-- Replaces the flat J2S rate table that was hardcoded and duplicated verbatim
-- across confirm-session-taught / confirm-session-delivery /
-- session-confirmation-cron / confirm-sub-delivery. Rates now live per-tenant,
-- keyed by (organization_id, role, session_type).
--
-- Empty for a tenant = no configured rate → the confirm functions leave
-- pay_amount_cents null and the admin sets the amount on the Payroll screen
-- (existing graceful-null behavior). This is deliberate: previously every
-- tenant silently inherited J2S's dollar amounts. Null-until-configured is the
-- multi-tenant-correct floor.
--
-- Money data: read + write gated to org admins (can_admin_org), matching the
-- money=Admin+ RBAC rule. Edge functions read via the service role (bypass RLS).

CREATE TABLE IF NOT EXISTS public.tenant_pay_rates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('lead','developing')),
  session_type     text NOT NULL CHECK (session_type IN ('morning','afternoon','full_day','after_school')),
  amount_cents     integer NOT NULL CHECK (amount_cents >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_pay_rates_org_role_session_uniq UNIQUE (organization_id, role, session_type)
);

CREATE INDEX IF NOT EXISTS idx_tenant_pay_rates_org ON public.tenant_pay_rates(organization_id);

ALTER TABLE public.tenant_pay_rates ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_pay_rates TO authenticated;
GRANT ALL ON public.tenant_pay_rates TO service_role;

DROP POLICY IF EXISTS tenant_pay_rates_admin_all ON public.tenant_pay_rates;
CREATE POLICY tenant_pay_rates_admin_all ON public.tenant_pay_rates
  FOR ALL TO authenticated
  USING (can_admin_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_admin_org(organization_id) OR is_platform_admin());

-- Backfill J2S's contractual rate card (pay_schedule v3.0) by slug lookup so
-- J2S computes identically to the old hardcoded table. Idempotent. No other
-- tenant is seeded — each provider configures their own rates.
INSERT INTO public.tenant_pay_rates (organization_id, role, session_type, amount_cents)
SELECT o.id, r.role, r.session_type, r.amount_cents
FROM public.organizations o
CROSS JOIN (VALUES
  ('lead','morning',8000),
  ('lead','afternoon',8000),
  ('lead','full_day',16000),
  ('lead','after_school',6000),
  ('developing','morning',6500),
  ('developing','afternoon',6500),
  ('developing','full_day',13000),
  ('developing','after_school',5000)
) AS r(role, session_type, amount_cents)
WHERE o.slug = 'j2s'
ON CONFLICT (organization_id, role, session_type) DO NOTHING;
