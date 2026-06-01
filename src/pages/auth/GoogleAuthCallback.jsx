// /auth/google/callback
//
// Lands here after Google redirects with ?code=...&state=...
// 1. Validate state against what we stashed in sessionStorage (CSRF guard)
// 2. POST { code, organization_id, redirect_uri } to the google-oauth-callback edge fn
// 3. Bounce back to /admin/settings with a toast query param
//
// Not part of /admin/* because the redirect URI is registered as a top-level
// path in the Google Cloud console — keeps redirect-URI matching simple.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase, API_BASE } from "../../lib/supabase.js";

const PURPLE = "#1C004F";
const MUTED = "#6b6b6b";
const CREAM = "#FBFBFB";

export default function GoogleAuthCallback() {
  const navigate = useNavigate();
  const [statusMsg, setStatusMsg] = useState("Finishing the Google Drive connection…");

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const code = params.get("code");
        const state = params.get("state");
        const errorParam = params.get("error");

        if (errorParam) {
          throw new Error(
            errorParam === "access_denied"
              ? "You declined the Google permission request. Try again when you're ready."
              : `Google returned an error: ${errorParam}`,
          );
        }
        if (!code || !state) {
          throw new Error("Google didn't return the expected response. Try connecting again.");
        }

        const expectedState = sessionStorage.getItem("google_oauth_state");
        const orgId = sessionStorage.getItem("google_oauth_org_id");
        const redirectUri = sessionStorage.getItem("google_oauth_redirect_uri");
        // Where to bounce back after success. Defaults to /admin/settings if
        // the launching surface didn't set one. Whitelist starts-with /admin
        // so a tampered value can't redirect off-site.
        const rawReturnTo = sessionStorage.getItem("google_oauth_return_to");
        const returnTo = rawReturnTo && rawReturnTo.startsWith("/admin")
          ? rawReturnTo
          : "/admin/settings";
        sessionStorage.removeItem("google_oauth_state");
        sessionStorage.removeItem("google_oauth_org_id");
        sessionStorage.removeItem("google_oauth_redirect_uri");
        sessionStorage.removeItem("google_oauth_return_to");

        if (!expectedState || state !== expectedState) {
          throw new Error("Connection request looked tampered (state mismatch). Try again.");
        }
        if (!orgId || !redirectUri) {
          throw new Error("Lost the connection request context. Try again from Settings.");
        }

        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("You were signed out mid-flow. Sign back in and try again.");

        if (mounted) setStatusMsg("Saving the connection…");
        const resp = await fetch(`${API_BASE}/google-oauth-callback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            code,
            organization_id: orgId,
            redirect_uri: redirectUri,
          }),
        });
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          throw new Error(json.error || `Connection failed (${resp.status}).`);
        }

        const sep = returnTo.includes("?") ? "&" : "?";
        navigate(`${returnTo}${sep}google=connected`, { replace: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const fallbackReturn = (sessionStorage.getItem("google_oauth_return_to") || "/admin/settings");
        const safeReturn = fallbackReturn.startsWith("/admin") ? fallbackReturn : "/admin/settings";
        sessionStorage.removeItem("google_oauth_return_to");
        const sep = safeReturn.includes("?") ? "&" : "?";
        navigate(`${safeReturn}${sep}google=error&error_message=${encodeURIComponent(msg)}`, { replace: true });
      }
    })();
    return () => { mounted = false; };
  }, [navigate]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: CREAM,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        fontFamily: "'Poppins', system-ui, sans-serif",
      }}
    >
      <div style={{ color: PURPLE, fontWeight: 700, fontSize: 22 }}>Enrops</div>
      <div style={{ color: MUTED, fontSize: 14 }}>{statusMsg}</div>
    </div>
  );
}
