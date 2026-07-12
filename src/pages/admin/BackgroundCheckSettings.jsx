// /admin/background-checks — set whether a background check is part of this
// org's instructor onboarding, and (until an automated provider is wired) how
// instructors are told to complete one.
//
// Config lives on organizations.background_check_config (JSONB):
//   { enabled, provider_name, provider_url, instructions }
// enabled=true  -> a required, gated onboarding step; the instructor can't
//                  finish onboarding until an admin marks their check clear.
// enabled=false -> the step is hidden and onboarding isn't gated on it.
//
// Owner/admin only, org-scoped: the update runs against the caller's own org
// row under the existing organizations UPDATE RLS. No tenant strings here —
// every provider sets their own copy. Mirrors the EmailSenderSettings save
// pattern (direct organizations update, dirty-gated Save).

import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const GREEN_BG = "#f0fdf4";
const GREEN_INK = "#166534";

// Normalize a typed link the way the signature editor does: assume https when
// the operator omits the scheme, so "verifiedvolunteers.com" still works.
function normalizeUrl(raw) {
  const v = (raw || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
}

export default function BackgroundCheckSettings() {
  const { org } = useOutletContext();
  const [enabled, setEnabled] = useState(true);
  const [providerName, setProviderName] = useState("");
  const [providerUrl, setProviderUrl] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saved, setSaved] = useState({ enabled: true, providerName: "", providerUrl: "", instructions: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  function flash(msg) { setToast(msg); setTimeout(() => setToast(""), 3000); }

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      // Read fresh from the org row so a save elsewhere is reflected — the
      // layout context is loaded once at mount.
      const { data } = await supabase
        .from("organizations")
        .select("background_check_config")
        .eq("id", org.id)
        .maybeSingle();
      if (cancelled) return;
      const cfg = data?.background_check_config ?? {};
      const next = {
        enabled: cfg.enabled !== false, // default on
        providerName: cfg.provider_name ?? "",
        providerUrl: cfg.provider_url ?? "",
        instructions: cfg.instructions ?? "",
      };
      setEnabled(next.enabled);
      setProviderName(next.providerName);
      setProviderUrl(next.providerUrl);
      setInstructions(next.instructions);
      setSaved(next);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  async function save() {
    setSaving(true); setError("");
    try {
      const config = {
        enabled,
        provider_name: providerName.trim() || null,
        provider_url: normalizeUrl(providerUrl) || null,
        instructions: instructions.trim() || null,
      };
      const enabledChanged = enabled !== saved.enabled;
      const { error: e } = await supabase
        .from("organizations")
        .update({ background_check_config: config })
        .eq("id", org.id);
      if (e) throw e;
      // Turning the flag on/off changes who the onboarding gate lets through, but
      // the gate only re-runs from the wizard/webhooks — so contractors already
      // waiting stay stuck until this reconcile fires. Non-fatal: the config is
      // saved regardless; the next natural gate run would eventually reconcile.
      if (enabledChanged) {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          const token = session?.access_token;
          if (token) {
            await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/reconcile-onboarding-gate`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
                apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
              },
              body: JSON.stringify({ organization_id: org.id }),
            });
          }
        } catch (_reconcileErr) { /* config already saved; gate reconciles on next run */ }
      }
      setSaved({
        enabled,
        providerName: providerName.trim(),
        providerUrl: normalizeUrl(providerUrl),
        instructions: instructions.trim(),
      });
      setProviderUrl(normalizeUrl(providerUrl));
      flash("Background check settings saved.");
    } catch (e) {
      setError(e.message ?? "Couldn't save your background check settings.");
    } finally {
      setSaving(false);
    }
  }

  const dirty =
    enabled !== saved.enabled ||
    providerName.trim() !== saved.providerName ||
    normalizeUrl(providerUrl) !== saved.providerUrl ||
    instructions.trim() !== saved.instructions;

  if (loading) {
    return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>;
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "8px 0 40px" }}>
      <Link to="/admin/settings" style={{ fontSize: 13, color: MUTED, textDecoration: "none" }}>← Settings</Link>
      <h1 style={{ margin: "8px 0 4px", color: PURPLE, fontSize: 24, fontWeight: 700 }}>Background checks</h1>
      <p style={{ color: MUTED, fontSize: 14, marginTop: 0, lineHeight: 1.5, maxWidth: 580 }}>
        Decide whether a background check is part of your instructors' onboarding, and point them to where they
        complete one. You run checks through your own provider and mark them clear here — nothing is shared with us.
      </p>

      {error && <div style={{ marginTop: 16, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}
      {toast && <div style={{ marginTop: 16, padding: "10px 12px", background: GREEN_BG, border: "1px solid #bbf7d0", borderRadius: 8, color: GREEN_INK, fontSize: 13 }}>{toast}</div>}

      <div style={{ marginTop: 20, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 20 }}>
        <label style={lbl}>Require a background check</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          <button type="button" onClick={() => setEnabled(true)} style={segBtn(enabled)}>On — required</button>
          <button type="button" onClick={() => setEnabled(false)} style={segBtn(!enabled)}>Off</button>
        </div>
        <div style={hint}>
          {enabled
            ? "Instructors see a background check step and can't finish onboarding until an admin marks their check clear."
            : "The background check step is hidden and onboarding won't wait on it. You can turn this back on anytime."}
        </div>

        {enabled && (
          <div style={{ borderTop: `1px solid ${RULE}`, margin: "22px 0 0", paddingTop: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
              How instructors complete their check
            </div>
            <div style={{ ...hint, marginTop: 0, marginBottom: 16 }}>
              Shown to the instructor during onboarding. If you add a link, we'll also include it in their invite
              email when they're added to your roster.
            </div>

            <label style={lbl}>Provider name</label>
            <input type="text" value={providerName} onChange={(e) => setProviderName(e.target.value)} placeholder="e.g. Verified Volunteers" style={input} />
            <div style={hint}>The service you use to run checks. Optional.</div>

            <label style={{ ...lbl, marginTop: 18 }}>Link to start a check</label>
            <input type="text" value={providerUrl} onChange={(e) => setProviderUrl(e.target.value)} placeholder="e.g. verifiedvolunteers.com/your-org" style={input} />
            <div style={hint}>Where the instructor goes to complete their check. Paste your provider's invite or sign-up link.</div>

            <label style={{ ...lbl, marginTop: 18 }}>Instructions for instructors</label>
            <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={4} placeholder="e.g. Click the link above and complete your check. It takes about 10 minutes and the results come to us automatically." style={{ ...input, resize: "vertical", lineHeight: 1.5 }} />
            <div style={hint}>A short note telling instructors what to do. Optional.</div>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
          <button type="button" onClick={save} disabled={saving || !dirty} style={primaryBtn(saving || !dirty)}>
            {saving ? "Saving…" : dirty ? "Save" : "Saved ✓"}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16, background: "#faf9ff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "16px 18px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>Recording results</div>
        <div style={{ ...hint, marginTop: 4 }}>
          When a check comes back, open <strong>Instructors</strong>, find the person, and use <strong>Upload prior BG check</strong> to
          record it. That clears their onboarding gate. An automated option that runs and returns checks inside Enrops is on the way.
        </div>
      </div>
    </div>
  );
}

const lbl = { display: "block", fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 };
const hint = { fontSize: 12.5, color: MUTED, marginTop: 6, lineHeight: 1.5 };
const input = { width: "100%", padding: "10px 12px", border: `1.5px solid ${RULE}`, borderRadius: 8, fontSize: 14, color: INK, background: "#fff", fontFamily: "inherit", boxSizing: "border-box" };
function segBtn(active) { return { padding: "7px 14px", background: active ? "#f0e3e8" : "#fff", color: active ? PURPLE : INK, border: `1.5px solid ${active ? BRIGHT : RULE}`, borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }; }
function primaryBtn(disabled) { return { padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
