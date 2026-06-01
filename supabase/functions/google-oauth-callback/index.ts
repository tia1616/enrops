// google-oauth-callback
//
// Exchanges a Google OAuth authorization code for access + refresh tokens,
// looks up the connected Google account's email, encrypts both tokens via
// Supabase Vault, and upserts into organization_google_tokens.
//
// Auth: the caller must be a signed-in admin/owner of the target organization.
// The OAuth code itself proves Google identity; this function pairs that
// identity with the caller's Enrops org membership.
//
// Request: POST { code: string, organization_id: string, redirect_uri: string }
//   - redirect_uri must match one of the URIs registered with this OAuth
//     client in Google Cloud Console (we send it back to Google when
//     exchanging the code; mismatch → invalid_grant)
//
// Response: 200 { ok: true, google_email: string } | 4xx { error: string }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_OAUTH_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!;
const GOOGLE_OAUTH_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonError(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function jsonOk(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function verifyAdmin(
  authHeader: string | null,
  organizationId: string,
): Promise<
  | { ok: true; userId: string; userClient: SupabaseClient }
  | { ok: false; reason: string; status: number }
> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, reason: "Missing Authorization header", status: 401 };
  }
  const token = authHeader.slice("Bearer ".length);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userResp, error: userErr } = await userClient.auth.getUser(token);
  if (userErr || !userResp?.user) {
    return { ok: false, reason: "Invalid session", status: 401 };
  }
  const userId = userResp.user.id;

  const { data: memberRow, error: memberErr } = await userClient
    .from("org_members")
    .select("role, accepted_at")
    .eq("auth_user_id", userId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (memberErr) {
    return { ok: false, reason: `Membership lookup failed: ${memberErr.message}`, status: 500 };
  }
  if (!memberRow || !memberRow.accepted_at) {
    return { ok: false, reason: "Not a member of that organization", status: 403 };
  }
  if (!["owner", "admin"].includes(memberRow.role)) {
    return { ok: false, reason: "Only org owners or admins can connect Google Drive", status: 403 };
  }
  return { ok: true, userId, userClient };
}

// Exchanges authorization code for tokens. Per Google's docs the response
// includes access_token (1h), refresh_token (long-lived, ONLY returned the
// first time the user grants consent for these scopes — subsequent reauths
// reuse the same refresh_token), expires_in (seconds), scope, token_type.
async function exchangeCodeForTokens(code: string, redirectUri: string) {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(`Google token exchange failed: ${json.error_description || json.error || resp.statusText}`);
  }
  return json as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    token_type: string;
    id_token?: string;
  };
}

// Decodes the email out of the id_token (a JWT). We don't verify the signature
// here because the token came directly from Google over HTTPS in response to
// our authenticated exchange — the chain of trust is the TLS connection, not
// the JWT signature.
function emailFromIdToken(idToken: string): string | null {
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;
    const padded = parts[1] + "===".slice((parts[1].length + 3) % 4);
    const payload = JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

// Fallback: call Google's userinfo endpoint if id_token isn't present or
// doesn't include email (some scopes don't grant email by default).
async function fetchGoogleEmail(accessToken: string): Promise<string> {
  const resp = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    throw new Error(`Could not fetch Google account email (${resp.status})`);
  }
  const json = await resp.json();
  if (typeof json.email !== "string") {
    throw new Error("Google didn't return an email for this account.");
  }
  return json.email as string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("Method not allowed", 405);

  let body: { code?: string; organization_id?: string; redirect_uri?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body");
  }
  const code = body.code?.trim();
  const organizationId = body.organization_id?.trim();
  const redirectUri = body.redirect_uri?.trim();
  if (!code) return jsonError("Missing 'code'");
  if (!organizationId) return jsonError("Missing 'organization_id'");
  if (!redirectUri) return jsonError("Missing 'redirect_uri'");

  const authCheck = await verifyAdmin(req.headers.get("Authorization"), organizationId);
  if (!authCheck.ok) return jsonError(authCheck.reason, authCheck.status);
  const { userId } = authCheck;

  // 1. Exchange code for tokens
  let tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
  try {
    tokens = await exchangeCodeForTokens(code, redirectUri);
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : String(e));
  }

  if (!tokens.refresh_token) {
    // Google only returns refresh_token on first consent. If this is a re-auth
    // and we lost the previous token, the user must revoke + reconnect. We
    // surface a clear message rather than silently storing an unrefreshable
    // access_token.
    return jsonError(
      "Google didn't return a refresh token. Revoke the existing Enrops access at https://myaccount.google.com/permissions and try connecting again.",
    );
  }

  // 2. Determine the connected Google account's email
  let googleEmail: string;
  try {
    googleEmail =
      (tokens.id_token && emailFromIdToken(tokens.id_token)) ||
      (await fetchGoogleEmail(tokens.access_token));
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : String(e));
  }

  // 3. Store tokens encrypted in Vault, then upsert the row
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // If a row already exists for (org, user), update existing vault secrets in
  // place instead of creating new ones (avoids vault.secrets accumulation).
  const { data: existing } = await admin
    .from("organization_google_tokens")
    .select("id, access_token_secret_id, refresh_token_secret_id")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .maybeSingle();

  const tokenExpiresAt = new Date(Date.now() + (tokens.expires_in - 60) * 1000).toISOString();
  const scopes = tokens.scope.split(" ").filter(Boolean);

  try {
    if (existing) {
      const { error: aErr } = await admin.rpc("vault_update_secret_text", {
        p_secret_id: existing.access_token_secret_id,
        p_secret_text: tokens.access_token,
      });
      if (aErr) throw new Error(`Vault update (access) failed: ${aErr.message}`);
      const { error: rErr } = await admin.rpc("vault_update_secret_text", {
        p_secret_id: existing.refresh_token_secret_id,
        p_secret_text: tokens.refresh_token,
      });
      if (rErr) throw new Error(`Vault update (refresh) failed: ${rErr.message}`);
      const { error: upErr } = await admin
        .from("organization_google_tokens")
        .update({
          google_email: googleEmail,
          token_expires_at: tokenExpiresAt,
          scopes,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      if (upErr) throw new Error(`Token row update failed: ${upErr.message}`);
    } else {
      const accessName = `google_access_token:${organizationId}:${userId}`;
      const refreshName = `google_refresh_token:${organizationId}:${userId}`;
      const { data: accessId, error: aErr } = await admin.rpc("vault_create_secret_text", {
        p_secret_text: tokens.access_token,
        p_secret_name: accessName,
      });
      if (aErr) throw new Error(`Vault create (access) failed: ${aErr.message}`);
      const { data: refreshId, error: rErr } = await admin.rpc("vault_create_secret_text", {
        p_secret_text: tokens.refresh_token,
        p_secret_name: refreshName,
      });
      if (rErr) throw new Error(`Vault create (refresh) failed: ${rErr.message}`);
      const { error: insErr } = await admin
        .from("organization_google_tokens")
        .insert({
          organization_id: organizationId,
          user_id: userId,
          google_email: googleEmail,
          access_token_secret_id: accessId,
          refresh_token_secret_id: refreshId,
          token_expires_at: tokenExpiresAt,
          scopes,
        });
      if (insErr) throw new Error(`Token row insert failed: ${insErr.message}`);
    }
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : String(e), 500);
  }

  return jsonOk({ ok: true, google_email: googleEmail });
});
