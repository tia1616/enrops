// src/pages/admin/AdminLogin.jsx
// Admin portal login — provider-facing (not parent-facing).
// Email + password auth. Redirects to /admin on success.
// Magic link option available but depends on SMTP being configured.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";

const PLUM = "#691D39";
const GOLD = "#CFB12F";
const CHALK = "#EAEADD";
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
      navigate("/admin");
    }
  }

  async function handleMagicLink() {
    if (!email) return;
    setLoading(true);
    setError("");
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('auth-send-magic-link', {
        body: {
          email,
          redirect_to: `${window.location.origin}/admin`,
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
      minHeight: "100vh", background: CHALK, display: "flex", alignItems: "center",
      justifyContent: "center", fontFamily: "'Space Grotesk', system-ui, sans-serif", padding: 24,
    }}>
      <div style={{
        width: "100%", maxWidth: 400, background: "#fff",
        border: `1px solid ${RULE}`, borderRadius: 8, padding: 32,
      }}>
        <div style={{ fontWeight: 700, fontSize: 22, color: PLUM, marginBottom: 4 }}>
          Enrops Admin
        </div>
        <p style={{ color: MUTED, fontSize: 14, margin: "0 0 24px" }}>
          Sign in to manage your programs, marketing, and operations.
        </p>

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
              width: "100%", padding: "10px 14px", background: PLUM, color: "#fff",
              border: "none", borderRadius: 6, fontSize: 14, fontWeight: 600,
              fontFamily: "inherit", cursor: loading ? "wait" : "pointer",
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div style={{
          textAlign: "center", margin: "16px 0 0", paddingTop: 16,
          borderTop: `1px solid ${RULE}`,
        }}>
          <button
            onClick={handleMagicLink}
            disabled={loading || !email}
            style={{
              background: "none", border: "none", color: PLUM,
              fontSize: 13, cursor: "pointer", fontFamily: "inherit",
              textDecoration: "underline", opacity: !email ? 0.4 : 1,
            }}
          >
            Email me a sign-in link instead
          </button>
        </div>

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

const labelStyle = {
  display: "block", fontSize: 12, fontWeight: 600, color: INK,
  marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5,
};

const inputStyle = {
  width: "100%", padding: "9px 12px", border: `1px solid ${RULE}`,
  borderRadius: 6, fontSize: 14, fontFamily: "inherit",
  background: "#fff", color: INK, boxSizing: "border-box",
};
