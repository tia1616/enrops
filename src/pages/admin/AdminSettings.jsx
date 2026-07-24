// /admin/settings — tenant-level settings. Currently just the Connections
// section (Google Drive). Future: branding edits, notification prefs, etc.
//
// Multi-tenant: connection rows are org-scoped via RLS. Each org admin sees
// their own org's connections. Copy is brand-neutral (no J2S strings).

import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
const VIOLET = "#8C88FF";
const CREAM = "#FBFBFB";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const GREEN = "#2f7d32";
const RED = "#a13a3a";

const GOOGLE_OAUTH_CLIENT_ID = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID || "";
const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export default function AdminSettings() {
  const { org, user } = useOutletContext();
  const [connection, setConnection] = useState(null); // { id, google_email, scopes, user_id } | null
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null); // { kind: 'success' | 'error', message }

  // Drain success/error toasts left by the /auth/google/callback page (passed
  // via location.search). We clear the query string after reading so refresh
  // doesn't re-fire the toast.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const googleStatus = params.get("google");
    const errorMsg = params.get("error_message");
    if (googleStatus === "connected") {
      setToast({ kind: "success", message: "Google Drive connected." });
    } else if (googleStatus === "error") {
      setToast({ kind: "error", message: errorMsg || "Google Drive connection failed." });
    }
    if (googleStatus) {
      const url = new URL(window.location.href);
      url.searchParams.delete("google");
      url.searchParams.delete("error_message");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("organization_google_tokens")
        .select("id, google_email, scopes, user_id, updated_at")
        .eq("organization_id", org.id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setToast({ kind: "error", message: `Couldn't check connection status: ${error.message}` });
      }
      setConnection(data ?? null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  function startConnect() {
    if (!GOOGLE_OAUTH_CLIENT_ID) {
      setToast({ kind: "error", message: "Google OAuth isn't configured (missing VITE_GOOGLE_OAUTH_CLIENT_ID)." });
      return;
    }
    if (!org?.id) return;
    const state = crypto.randomUUID();
    const redirectUri = `${window.location.origin}/auth/google/callback`;
    // Stash everything the callback page needs to complete the exchange. State
    // is the CSRF anchor; org_id tells the callback which org to attach to.
    sessionStorage.setItem("google_oauth_state", state);
    sessionStorage.setItem("google_oauth_org_id", org.id);
    sessionStorage.setItem("google_oauth_redirect_uri", redirectUri);

    const params = new URLSearchParams({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      // openid+email gets us the connected account's email for display;
      // drive.readonly is the actual access scope.
      scope: ["openid", "email", GOOGLE_DRIVE_SCOPE].join(" "),
      access_type: "offline",
      // prompt=consent forces Google to return a refresh_token even on
      // re-auth. Without it we'd only get access_token (1h, no refresh).
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async function disconnect() {
    if (!connection?.id || busy) return;
    if (!window.confirm("Disconnect Google Drive? You can reconnect anytime.")) return;
    setBusy(true);
    try {
      // The RLS policy "user_manages_own_google_token" only lets the user
      // who created the token row delete it. If a different admin tries to
      // disconnect a teammate's connection, they'll get 0 rows affected.
      const { error, count } = await supabase
        .from("organization_google_tokens")
        .delete({ count: "exact" })
        .eq("id", connection.id);
      if (error) throw error;
      if (count === 0) {
        throw new Error(`Only ${connection.google_email} can disconnect this connection (they set it up).`);
      }
      // Note: vault secret rows are left behind here — they're not reachable
      // without the secret_id from the deleted row, so they're harmless. We
      // could vacuum them with a vault_delete_secret RPC in a follow-up.
      setConnection(null);
      setToast({ kind: "success", message: "Google Drive disconnected." });
    } catch (e) {
      setToast({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 style={{ margin: 0, color: PURPLE, fontSize: 26, fontWeight: 700 }}>Settings</h1>
      <p style={{ color: MUTED, fontSize: 14, margin: "6px 0 22px", lineHeight: 1.5 }}>
        Connect your organization to outside services and manage your account.
      </p>

      {toast && (
        <div
          style={{
            ...toastStyle,
            background: toast.kind === "success" ? "#f0f8f0" : "#fff5f5",
            borderColor: toast.kind === "success" ? "#bfd9bf" : "#f0c4c4",
            color: toast.kind === "success" ? GREEN : RED,
          }}
        >
          <span>{toast.message}</span>
          <button type="button" onClick={() => setToast(null)} style={toastClose}>×</button>
        </div>
      )}

      <section style={{ marginTop: 12 }}>
        <h2 style={sectionTitle}>Waivers &amp; policies</h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>Waivers &amp; policies</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 2, lineHeight: 1.5, maxWidth: 460 }}>
              The forms families sign to enroll, plus the privacy policy and terms you publish on your registration site.
            </div>
          </div>
          <Link to="/admin/waivers" style={{ flexShrink: 0, padding: "9px 16px", background: BRIGHT, color: "#fff", borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Manage →</Link>
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={sectionTitle}>Registration questions</h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>What your form asks families</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5, maxWidth: 520 }}>
              Choose the pickup, release, and guardian details your registration form collects, and add your own questions. Turn off anything you don't need.
            </div>
          </div>
          <Link to="/admin/registration-questions" style={{ flexShrink: 0, padding: "9px 16px", background: BRIGHT, color: "#fff", borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Manage →</Link>
        </div>
      </section>

      {/* Lean ops (enrops_platform) don't get a top-level Locations nav item —
          they manage venues here or inline in the program builder. J2S keeps its
          own top-level Partners item, so this would be redundant for them. */}
      {org?.instructor_pay_model === "enrops_platform" && (
        <section style={{ marginTop: 24 }}>
          <h2 style={sectionTitle}>Locations</h2>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>Where your programs run</div>
              <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5, maxWidth: 520 }}>
                Manage the venues families see at checkout. You can also set a location right in the program builder.
              </div>
            </div>
            <Link to="/admin/schools" style={{ flexShrink: 0, padding: "9px 16px", background: BRIGHT, color: "#fff", borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Manage →</Link>
          </div>
        </section>
      )}

      {org?.instructor_pay_model !== "enrops_platform" && (
      <section style={{ marginTop: 24 }}>
        <h2 style={sectionTitle}>Availability survey</h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>Survey questions &amp; intro</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5, maxWidth: 520 }}>
              Choose which questions the instructor availability survey asks and set a default intro. Turn off anything you don't need.
            </div>
          </div>
          <Link to="/admin/survey-settings" style={{ flexShrink: 0, padding: "9px 16px", background: BRIGHT, color: "#fff", borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Manage →</Link>
        </div>
      </section>
      )}

      <section style={{ marginTop: 24 }}>
        <h2 style={sectionTitle}>Branding</h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>Logo &amp; colors</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5, maxWidth: 520 }}>
              Set your logo and brand colors once — they appear on your registration page and every email you send.
            </div>
          </div>
          <Link to="/admin/branding" style={{ flexShrink: 0, padding: "9px 16px", background: BRIGHT, color: "#fff", borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Manage →</Link>
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={sectionTitle}>Email sender</h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>How your emails show up</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5, maxWidth: 520 }}>
              Set the sender name, reply-to address, email signature, and mailing address that show on your invites, waivers, and reminders. We handle the sending domain — no DNS setup.
            </div>
          </div>
          <Link to="/admin/email-sender" style={{ flexShrink: 0, padding: "9px 16px", background: BRIGHT, color: "#fff", borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Manage →</Link>
        </div>
      </section>

      {org?.instructor_pay_model !== "enrops_platform" && (
      <section style={{ marginTop: 24 }}>
        <h2 style={sectionTitle}>Pay rates</h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>What you pay instructors</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5, maxWidth: 520 }}>
              Set your per-session pay for lead and developing instructors. Enrops fills these amounts in automatically when a session is confirmed, so payroll adds up on its own.
            </div>
          </div>
          <Link to="/admin/pay-rates" style={{ flexShrink: 0, padding: "9px 16px", background: BRIGHT, color: "#fff", borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Manage →</Link>
        </div>
      </section>
      )}

      {org?.instructor_pay_model !== "enrops_platform" && (
      <section style={{ marginTop: 24 }}>
        <h2 style={sectionTitle}>Background checks</h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>Instructor background checks</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5, maxWidth: 520 }}>
              Choose whether a background check is required in onboarding, and tell instructors where to complete one. Turn it off if you don't need it.
            </div>
          </div>
          <Link to="/admin/background-checks" style={{ flexShrink: 0, padding: "9px 16px", background: BRIGHT, color: "#fff", borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Manage →</Link>
        </div>
      </section>
      )}

      {org?.instructor_pay_model !== "enrops_platform" && (
      <section style={{ marginTop: 24 }}>
        <h2 style={sectionTitle}>Training videos</h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>Instructor training videos</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5, maxWidth: 520 }}>
              Upload training videos new instructors must watch during onboarding — no skipping or speeding up — with optional comprehension questions. Turn it off if you don't need it.
            </div>
          </div>
          <Link to="/admin/training" style={{ flexShrink: 0, padding: "9px 16px", background: BRIGHT, color: "#fff", borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Manage →</Link>
        </div>
      </section>
      )}

      <section style={{ marginTop: 24 }}>
        <h2 style={sectionTitle}>Connections</h2>

        <div style={connectionCard}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={iconBox}>
              <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
                {/* Simple Drive triangle mark — no need to load Google's logo SVG */}
                <path fill={VIOLET} d="M7.71 3h8.58l5.71 9.86-4.29 7.43H6.29L2 12.86 7.71 3z" />
              </svg>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15, color: INK }}>Google Drive</div>
              <div style={{ color: MUTED, fontSize: 13, marginTop: 2 }}>
                {loading
                  ? "Checking connection…"
                  : connection
                  ? <>Connected as <strong style={{ color: INK }}>{connection.google_email}</strong></>
                  : org?.instructor_pay_model === "enrops_platform"
                  ? "Connect your Google Drive to import documents directly into Enrops."
                  : "Connect your Google Drive to import curriculum documents directly into Enrops."}
              </div>
            </div>
            <div>
              {loading ? null : connection ? (
                <button type="button" onClick={disconnect} disabled={busy} style={secondaryBtn}>
                  {busy ? "Disconnecting…" : "Disconnect"}
                </button>
              ) : (
                <button type="button" onClick={startConnect} style={primaryBtn}>
                  Connect Google Drive
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// --- styles ---

const sectionTitle = { fontSize: 13, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 12 };

const connectionCard = {
  background: PANEL,
  border: `1px solid ${RULE}`,
  borderRadius: 12,
  padding: 18,
};

const iconBox = {
  width: 40,
  height: 40,
  borderRadius: 8,
  background: CREAM,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const primaryBtn = {
  padding: "9px 16px",
  background: BRIGHT,
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const secondaryBtn = {
  padding: "9px 16px",
  background: "transparent",
  color: BRIGHT,
  border: `1px solid ${BRIGHT}`,
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const toastStyle = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  border: "1px solid",
  borderRadius: 6,
  fontSize: 13,
  marginBottom: 16,
};

const toastClose = {
  marginLeft: "auto",
  background: "transparent",
  border: "none",
  fontSize: 18,
  cursor: "pointer",
  color: "inherit",
  lineHeight: 1,
  padding: 0,
};
