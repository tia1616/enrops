// update-org-logo — set an org's canonical logo and derive its email-safe copy.
//
// One logo feeds everything: organizations.logo_url is the source (SVG or raster,
// shown on the public/registration page), and organizations.logo_email_url is a
// rasterized PNG for email (email clients don't reliably render SVG). This fn is
// the single trigger: it sets logo_url, then calls regenerate-email-logo (which
// needs the service-role key, so the browser can't call it directly) to produce
// the PNG. Passing logo_url = null clears both.
//
// Org-admin (or platform-admin) gated; a caller can only touch orgs they admin.
// Body: { organization_id, logo_url }  →  { ok, logo_url, logo_email_url }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function jsonError(error: string, status = 400) {
  return new Response(JSON.stringify({ error }), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function jsonOk(data: Record<string, unknown>) {
  return new Response(JSON.stringify(data), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function verifyAdminOf(authHeader: string | null, orgId: string): Promise<{ ok: true } | { ok: false; reason: string; status: number }> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return { ok: false, reason: "Missing Authorization header", status: 401 };
  const token = authHeader.slice("Bearer ".length);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userResp, error: userErr } = await userClient.auth.getUser(token);
  if (userErr || !userResp?.user) return { ok: false, reason: "Invalid session", status: 401 };
  const userId = userResp.user.id;
  const { data: paRow } = await userClient.from("platform_admins").select("auth_user_id").eq("auth_user_id", userId).maybeSingle();
  if (paRow) return { ok: true };
  const { data: orgRows } = await userClient
    .from("org_members")
    .select("organization_id, role, accepted_at")
    .eq("auth_user_id", userId)
    .in("role", ["owner", "admin"]);
  const isAdmin = (orgRows ?? []).some(
    (r: { organization_id: string; accepted_at: string | null }) => r.accepted_at && r.organization_id === orgId,
  );
  if (!isAdmin) return { ok: false, reason: "Not an admin of this organization", status: 403 };
  return { ok: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const orgId = String(body.organization_id ?? "").trim();
    if (!orgId) return jsonError("organization_id required");
    const rawLogo = body.logo_url;
    const logoUrl = rawLogo === null || rawLogo === undefined || String(rawLogo).trim() === "" ? null : String(rawLogo).trim();

    const auth = await verifyAdminOf(req.headers.get("Authorization"), orgId);
    if (!auth.ok) return jsonError(auth.reason, auth.status);

    // SSRF guard (codex review #1): logo_url is fetched server-side later by
    // regenerate-email-logo. Only accept a Supabase Storage public URL under THIS
    // org's own org-assets folder — never an arbitrary URL, which could aim the
    // edge runtime at internal/attacker hosts or an oversized body. Real uploads
    // always land at {SUPABASE_URL}/storage/v1/object/public/org-assets/{orgId}/...
    if (logoUrl) {
      const allowedPrefix = `${SUPABASE_URL}/storage/v1/object/public/org-assets/${orgId}/`;
      if (!logoUrl.startsWith(allowedPrefix)) {
        return jsonError("logo_url must be an uploaded org-assets file for this organization", 400);
      }
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    // Set the source logo first.
    const { error: updErr } = await admin.from("organizations").update({ logo_url: logoUrl }).eq("id", orgId);
    if (updErr) return jsonError(`Couldn't save the logo: ${updErr.message}`, 500);

    if (!logoUrl) {
      // Removing the logo clears the derived email copy too.
      await admin.from("organizations").update({ logo_email_url: null }).eq("id", orgId);
      return jsonOk({ ok: true, logo_url: null, logo_email_url: null });
    }

    // Derive the email-safe PNG. regenerate-email-logo reads logo_url and writes
    // logo_email_url; it authenticates via the service-role bearer.
    let emailLogo = logoUrl;
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/regenerate-email-logo`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify({ org_id: orgId }),
      });
      const out = await resp.json().catch(() => ({}));
      if (resp.ok && out?.logo_email_url) {
        emailLogo = out.logo_email_url;
      } else {
        // Rasterization failed — fall back to using the source directly for email
        // (fine when it's already a PNG/JPG) so the org still has an email logo.
        await admin.from("organizations").update({ logo_email_url: logoUrl }).eq("id", orgId);
      }
    } catch {
      await admin.from("organizations").update({ logo_email_url: logoUrl }).eq("id", orgId);
    }

    return jsonOk({ ok: true, logo_url: logoUrl, logo_email_url: emailLogo });
  } catch (e) {
    return jsonError((e as Error).message ?? "Internal error", 500);
  }
});
