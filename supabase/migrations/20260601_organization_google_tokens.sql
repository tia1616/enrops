-- organization_google_tokens — per-org Google OAuth tokens for Drive Import.
-- Tokens are stored encrypted in Supabase Vault; this table holds the
-- vault.secrets UUIDs that the edge functions dereference (with service-role
-- access). Plaintext tokens never live in this table.
--
-- Multi-tenant: org-scoped via RLS. Each org admin can see connection status
-- (so the settings page can render "Connected as jessica@..."), but the only
-- way to actually use a token is the service-role edge function path, so
-- showing a row to an admin doesn't expose the token.
--
-- Run date: 2026-06-01

CREATE TABLE IF NOT EXISTS organization_google_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  google_email TEXT NOT NULL,
  -- vault.secrets.id references (UUIDs). The vault rows themselves hold the
  -- encrypted access_token / refresh_token; only service-role can decrypt via
  -- the vault.decrypted_secrets view.
  access_token_secret_id UUID NOT NULL,
  refresh_token_secret_id UUID NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  scopes TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS organization_google_tokens_org_idx
  ON organization_google_tokens(organization_id);

ALTER TABLE organization_google_tokens ENABLE ROW LEVEL SECURITY;

-- Org members can SEE that a connection exists (for the settings card UI).
-- They cannot use the secret_id values to read tokens — those require
-- service_role to call vault.decrypted_secrets.
CREATE POLICY "org_members_read_google_tokens" ON organization_google_tokens
  FOR SELECT USING (
    organization_id IN (
      SELECT organization_id FROM org_members WHERE auth_user_id = auth.uid()
    )
  );

-- Only the user who granted the token can update or delete their own row.
-- (Connect / disconnect actions go through their own session, never an admin's.)
CREATE POLICY "user_manages_own_google_token" ON organization_google_tokens
  FOR ALL USING (
    user_id = auth.uid()
    AND organization_id IN (
      SELECT organization_id FROM org_members WHERE auth_user_id = auth.uid()
    )
  )
  WITH CHECK (
    user_id = auth.uid()
    AND organization_id IN (
      SELECT organization_id FROM org_members WHERE auth_user_id = auth.uid()
    )
  );

-- updated_at: edge functions explicitly set this on UPDATE (matches the
-- codebase convention; no auto-bump trigger).

-- ---------------------------------------------------------------------------
-- Vault wrappers (service-role only) — PostgREST/Supabase clients can't call
-- vault.create_secret / vault.update_secret directly because the `vault`
-- schema isn't exposed over the API. These SECURITY DEFINER wrappers run as
-- the vault owner so service-role clients can encrypt + rotate token text.
--
-- Authorization: REVOKE from PUBLIC + anon + authenticated, GRANT only to
-- service_role. Edge functions using SUPABASE_SERVICE_ROLE_KEY can call
-- these; user-scoped Supabase clients cannot.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.vault_create_secret_text(
  p_secret_text text,
  p_secret_name text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public
AS $$
DECLARE
  v_id uuid;
BEGIN
  v_id := vault.create_secret(p_secret_text, p_secret_name, 'Enrops OAuth token');
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.vault_update_secret_text(
  p_secret_id uuid,
  p_secret_text text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public
AS $$
BEGIN
  PERFORM vault.update_secret(p_secret_id, p_secret_text);
END;
$$;

-- Decrypts a vault secret by ID. Only callable by service_role.
CREATE OR REPLACE FUNCTION public.vault_read_secret_text(
  p_secret_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public
AS $$
DECLARE
  v_text text;
BEGIN
  SELECT decrypted_secret INTO v_text FROM vault.decrypted_secrets WHERE id = p_secret_id;
  RETURN v_text;
END;
$$;

-- Deletes a vault secret. Used when an org disconnects Google Drive.
CREATE OR REPLACE FUNCTION public.vault_delete_secret(
  p_secret_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public
AS $$
BEGIN
  DELETE FROM vault.secrets WHERE id = p_secret_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.vault_create_secret_text(text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.vault_update_secret_text(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.vault_read_secret_text(uuid)         FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.vault_delete_secret(uuid)            FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.vault_create_secret_text(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.vault_update_secret_text(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.vault_read_secret_text(uuid)         TO service_role;
GRANT EXECUTE ON FUNCTION public.vault_delete_secret(uuid)            TO service_role;
