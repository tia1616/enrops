// src/pages/admin/AdminLogin.jsx
// Universal Enrops sign-in (provider-facing — admins + contractors land here
// when their PWA-installed app icon detects no session). Despite the file
// name and URL path, this is NOT admin-only: after auth we hand off to '/'
// where EnropsLanding's smart-redirect routes by role (org_member → /admin,
// instructor → /:slug/instructor). Parents have their own sign-in at
// /j2s/login since they're tenant-scoped.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";

const ALLOW_PASSWORD = import.meta.env.VITE_ALLOW_PASSWORD_AUTH === "true";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
const VIOLET = "#8C88FF";
const CREAM = "#FBFBFB";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const DANGER = "#b3261e";

export default function AdminLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  async function handlePassword(e) {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    setError("");
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (err) {
      setError(err.message);
    } else {
      navigate("/");
    }
  }

  async function handleGoogle() {
    setLoading(true);
    setError("");
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/` },
    });
    if (err) {
      setError(err.message);
      setLoading(false);
    }
    // On success the browser is redirected to Google; no further state needed here.
  }

  async function handleMagicLink() {
    if (!email) return;
    setLoading(true);
    setError("");
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('auth-send-magic-link', {
        body: {
          email,
          redirect_to: `${window.location.origin}/`,
          context: 'admin',
        },
      });
      if (fnErr) throw fnErr;
      if (data?.error) throw new Error(data.error);
      setMsg(`Check ${email} for your sign-in link.`);
    } catch (err) {
      setError(err.message || "Could not send sign-in link. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: "100vh", background: CREAM, display: "flex", alignItems: "center",
      justifyContent: "center", fontFamily: "'Poppins', system-ui, sans-serif", padding: 24,
    }}>
      <div style={{
        width: "100%", maxWidth: 400, background: "#fff",
        border: `1px solid ${RULE}`, borderRadius: 12, padding: 32,
      }}>
        <div style={{ fontWeight: 700, fontSize: 22, color: PURPLE, marginBottom: 4 }}>
          Sign in to Enrops
        </div>
        <p style={{ color: MUTED, fontSize: 14, margin: "0 0 24px" }}>
          We'll send you to the right place after you sign in.
        </p>

        <button
          type="button"
          onClick={handleGoogle}
          disabled={loading}
          style={{
            width: "100%",
            padding: "10px 14px",
            background: "#fff",
            color: INK,
            border: `1px solid ${RULE}`,
            borderRadius: 6,
            fontSize: 14,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: loading ? "wait" : "pointer",
            opacity: loading ? 0.7 : 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            marginBottom: 16,
          }}
        >
          <GoogleG />
          Continue with Google
        </button>

        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          margin: "0 0 16px",
          color: MUTED,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.6,
        }}>
          <span style={{ flex: 1, height: 1, background: RULE }} />
          or
          <span style={{ flex: 1, height: 1, background: RULE }} />
        </div>

        {ALLOW_PASSWORD ? (
          <form onSubmit={handlePassword}>
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                style={inputStyle}
                autoComplete="email"
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Your password"
                style={inputStyle}
                autoComplete="current-password"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !email || !password}
              style={{
                width: "100%", padding: "10px 14px", background: BRIGHT, color: "#fff",
                border: "none", borderRadius: 6, fontSize: 14, fontWeight: 600,
                fontFamily: "inherit", cursor: loading ? "wait" : "pointer",
                opacity: loading ? 0.7 : 1,
              }}
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
            <div style={{ textAlign: "center", marginTop: 12 }}>
              <button
                type="button"
                onClick={handleMagicLink}
                disabled={loading || !email}
                style={{
                  background: "none", border: "none", color: PURPLE,
                  fontSize: 13, cursor: "pointer", fontFamily: "inherit",
                  textDecoration: "underline", opacity: !email ? 0.4 : 1,
                }}
              >
                Email me a sign-in link instead
              </button>
            </div>
          </form>
        ) : (
          <div>
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                style={inputStyle}
                autoComplete="email"
              />
            </div>
            <button
              type="button"
              onClick={handleMagicLink}
              disabled={loading || !email}
              style={{
                width: "100%", padding: "10px 14px", background: BRIGHT, color: "#fff",
                border: "none", borderRadius: 6, fontSize: 14, fontWeight: 600,
                fontFamily: "inherit", cursor: loading ? "wait" : "pointer",
                opacity: (loading || !email) ? 0.7 : 1,
              }}
            >
              {loading ? "Sending…" : "Email me a sign-in link"}
            </button>
          </div>
        )}

        {error && (
          <div style={{
            marginTop: 14, padding: 10, borderRadius: 4,
            background: "#fdecea", color: DANGER, fontSize: 13,
          }}>
            {error}
          </div>
        )}
        {msg && (
          <div style={{
            marginTop: 14, padding: 10, borderRadius: 4,
            background: "#e8f5e9", color: "#2e7d32", fontSize: 13,
          }}>
            {msg}
          </div>
        )}
      </div>
    </div>
  );
}

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
      <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
      <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
      <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571.001-.001.002-.001.003-.002l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/>
    </svg>
  );
}

const labelStyle = {
  display: "block", fontSize: 12, fontWeight: 600, color: INK,
  marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5,
};

const inputStyle = {
  width: "100%", padding: "9px 12px", border: `1px solid ${RULE}`,
  borderRadius: 6, fontSize: 14, fontFamily: "inherit",
  background: "#fff", color: INK, boxSizing: "border-box",
};
