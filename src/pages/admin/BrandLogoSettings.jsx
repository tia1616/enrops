// /admin/branding — one place to set the org's logo.
//
// This single upload is the canonical logo: it feeds BOTH the registration /
// public page (organizations.logo_url) and the header of every outgoing email
// (organizations.logo_email_url). We write the same file to both so there's
// one thing to manage — no separate "web logo" vs "email logo" for operators.
//
// Raster only (PNG/JPG/WebP): email clients don't reliably render SVG, so we
// keep operators from uploading one that silently breaks in inboxes.

import { useEffect, useRef, useState } from "react";
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

export default function BrandLogoSettings() {
  const { org } = useOutletContext();
  const [logoUrl, setLogoUrl] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const fileRef = useRef(null);

  function flash(msg) { setToast(msg); setTimeout(() => setToast(""), 3000); }

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from("organizations")
        .select("logo_url, logo_email_url")
        .eq("id", org.id)
        .maybeSingle();
      if (!cancelled) {
        // Prefer the web logo; fall back to the email logo if only that is set.
        const url = data?.logo_url || data?.logo_email_url || "";
        setLogoUrl(url);
        setSaved(url);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = "";
    if (!file) return;
    setError("");
    const OK = ["image/png", "image/jpeg", "image/webp"];
    if (!OK.includes(file.type)) {
      setError("Please choose a PNG, JPG, or WebP. (SVG doesn't display in email.)");
      return;
    }
    if (file.size > 2_000_000) {
      setError("That image is over 2 MB. Please use a smaller file.");
      return;
    }
    setUploading(true);
    try {
      const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
      // Path starts with the org id so the org-assets bucket RLS allows the write.
      const path = `${org.id}/logo/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("org-assets")
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from("org-assets").getPublicUrl(path);
      if (!pub?.publicUrl) throw new Error("Couldn't get the image URL.");
      setLogoUrl(pub.publicUrl);
    } catch (err) {
      setError(err.message ?? "Couldn't upload that image.");
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    setSaving(true); setError("");
    try {
      const url = logoUrl.trim() || null;
      // One file → both the web logo and the email-header logo.
      const { error: e } = await supabase
        .from("organizations")
        .update({ logo_url: url, logo_email_url: url })
        .eq("id", org.id);
      if (e) throw e;
      flash("Logo saved.");
      setSaved(logoUrl);
    } catch (e) {
      setError(e.message ?? "Couldn't save your logo.");
    } finally {
      setSaving(false);
    }
  }

  const dirty = logoUrl !== saved;

  if (loading) {
    return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>;
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "8px 0 40px" }}>
      <Link to="/admin/settings" style={{ fontSize: 13, color: MUTED, textDecoration: "none" }}>← Settings</Link>
      <h1 style={{ margin: "8px 0 4px", color: PURPLE, fontSize: 24, fontWeight: 700 }}>Logo</h1>
      <p style={{ color: MUTED, fontSize: 14, marginTop: 0, lineHeight: 1.5, maxWidth: 560 }}>
        Your logo appears at the top of every email you send and on your registration page. Upload it
        once here and it's used everywhere.
      </p>

      {error && <div style={{ marginTop: 16, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}
      {toast && <div style={{ marginTop: 16, padding: "10px 12px", background: GREEN_BG, border: "1px solid #bbf7d0", borderRadius: 8, color: GREEN_INK, fontSize: 13 }}>{toast}</div>}

      <div style={{ marginTop: 20, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ width: 160, height: 90, borderRadius: 8, border: `1px ${logoUrl ? "solid" : "dashed"} ${RULE}`, display: "flex", alignItems: "center", justifyContent: "center", background: "#faf9ff", overflow: "hidden" }}>
            {logoUrl
              ? <img src={logoUrl} alt="Your logo" style={{ maxWidth: "88%", maxHeight: "80%", objectFit: "contain" }} />
              : <span style={{ color: MUTED, fontSize: 12 }}>No logo yet</span>}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleFile} style={{ display: "none" }} />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} style={ghostBtn(uploading)}>
              {uploading ? "Uploading…" : logoUrl ? "Replace logo" : "Upload logo"}
            </button>
            {logoUrl && !uploading && (
              <button type="button" onClick={() => setLogoUrl("")} style={{ ...ghostBtn(false), color: MUTED, borderColor: RULE }}>Remove</button>
            )}
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: MUTED, marginTop: 12, lineHeight: 1.5 }}>
          PNG, JPG, or WebP, under 2 MB. A transparent PNG looks best on both light and dark backgrounds.
          (SVG isn't supported — many email apps won't show it.)
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
          <button type="button" onClick={save} disabled={saving || !dirty} style={primaryBtn(saving || !dirty)}>{saving ? "Saving…" : dirty ? "Save" : "Saved ✓"}</button>
        </div>
      </div>
    </div>
  );
}

function primaryBtn(disabled) { return { padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
function ghostBtn(disabled) { return { padding: "9px 14px", background: "#fff", color: BRIGHT, border: `1.5px solid ${BRIGHT}`, borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
