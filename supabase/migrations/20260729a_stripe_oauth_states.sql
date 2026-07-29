-- stripe_oauth_states — single-use, short-lived handoff tokens for connecting an
-- operator's EXISTING Stripe account via Connect OAuth.
--
-- WHY A TABLE AND NOT A SIGNED TOKEN. The callback is a browser redirect from
-- Stripe, so it carries no Supabase JWT and must run service-role. That makes the
-- state parameter the only thing standing between "this operator connected their
-- Stripe" and "somebody bound a Stripe account to an org they do not own". An
-- HMAC-signed token proves we minted it, but it stays valid until it expires and
-- can be replayed. A row can be marked consumed exactly once, which is the
-- property we actually need.
--
-- It also gives us an audit trail: who started the connect, for which org, when,
-- and whether it completed.
--
-- Additive and inert: nothing reads this table until stripe-oauth-start and
-- stripe-oauth-callback are deployed.

CREATE TABLE IF NOT EXISTS public.stripe_oauth_states (
  state              text PRIMARY KEY,
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz,
  -- Where to send the operator when the callback finishes. Stored HERE rather
  -- than carried in the redirect URL: the callback runs without a JWT, so any
  -- origin it read from the query string would be attacker-controlled and it
  -- would happily bounce the operator to it.
  return_origin      text NOT NULL,
  -- Recorded on success so a support question ("which account did they pick?")
  -- is answerable without reading Stripe.
  connected_account_id text
);

COMMENT ON TABLE public.stripe_oauth_states IS
  'Single-use state tokens for Stripe Connect OAuth. Minted by stripe-oauth-start, consumed by stripe-oauth-callback. Service-role only.';

CREATE INDEX IF NOT EXISTS idx_stripe_oauth_states_expires_at
  ON public.stripe_oauth_states (expires_at);

CREATE INDEX IF NOT EXISTS idx_stripe_oauth_states_org
  ON public.stripe_oauth_states (organization_id);

-- RLS on, and deliberately NO policies: this table is reachable only by
-- service_role (which bypasses RLS). No operator, admin, or anon client has any
-- business reading or writing these tokens, and a token that leaked to a browser
-- would be the whole vulnerability.
ALTER TABLE public.stripe_oauth_states ENABLE ROW LEVEL SECURITY;

-- Postgres grants to PUBLIC by default on some setups; be explicit in both
-- directions rather than trusting the default.
REVOKE ALL ON public.stripe_oauth_states FROM PUBLIC;
REVOKE ALL ON public.stripe_oauth_states FROM anon;
REVOKE ALL ON public.stripe_oauth_states FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stripe_oauth_states TO service_role;
