// /admin/branding — one home for the org's visual identity: logo + colors.
//
// Logo: a single upload is canonical. update-org-logo sets organizations.logo_url
// (SVG or raster, shown on the registration/public page) and derives an
// email-safe PNG (logo_email_url) via regenerate-email-logo. One upload → web
// AND email; operators never manage two files.
//
// Colors: the four brand colors live on org_branding and already feed both the
// public page and email templates (via _shared/orgBrand.ts). This is just the
// self-serve editor for them.

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

// Shown in the pickers when an org hasn't set a color yet (Enrops defaults).
const DEFAULTS = { primary: "#1C004F", secondary: "#8C88FF", accent: "#F8A638", pageBg: "#FBFBFB" };
const COLOR_FIELDS = [
  { key: "primary", col: "primary_color", label: "Primary", help: "Buttons, links, headings." },
  { key: "accent", col: "accent_color", label: "Accent", help: "Highlights and call-to-action bits." },
  { key: "secondary", col: "secondary_color", label: "Secondary", help: "Supporting elements." },
  { key: "pageBg", col: "page_bg_color", label: "Page background", help: "Behind your registration page." },
];

export default function BrandLogoSettings() {
  const { org } = useOutletContext();
  const [logoUrl, setLogoUrl] = useState("");
  const [savedLogo, setSavedLogo] = useState("");
  const [colors, setColors] = useState(DEFAULTS);
  const [savedColors, setSavedColors] = useState(DEFAULTS);
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
      const { data: o } = await supabase
        .from("organizations").select("logo_url, logo_email_url").eq("id", org.id).maybeSingle();
      const { data: b } = await supabase
        .from("org_branding").select("primary_color, secondary_color, accent_color, page_bg_color")
        .eq("organization_id", org.id).maybeSingle();
      if (!cancelled) {
        const url = o?.logo_url || o?.logo_email_url || "";
        const c = {
          primary: b?.primary_color || DEFAULTS.primary,
          secondary: b?.secondary_color || DEFAULTS.secondary,
          accent: b?.accent_color || DEFAULTS.accent,
          pageBg: b?.page_bg_color || DEFAULTS.pageBg,
        };
        setLogoUrl(url); setSavedLogo(url);
        setColors(c); setSavedColors(c);
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
    // SVG allowed for the web logo; we auto-generate an email-safe PNG on save.
    const OK = ["image/svg+xml", "image/png", "image/jpeg", "image/webp"];
    if (!OK.includes(file.type)) { setError("Please choose an SVG, PNG, JPG, or WebP image."); return; }
    if (file.size > 2_000_000) { setError("That image is over 2 MB. Please use a smaller file."); return; }
    setUploading(true);
    try {
      const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
      const path = `${org.id}/logo/${Date.now()}.${ext}`; // org-id prefix satisfies bucket RLS
      const { error: upErr } = await supabase.storage
        .from("org-assets").upload(path, file, { contentType: file.type, upsert: false });
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

  const logoDirty = logoUrl !== savedLogo;
  const colorsDirty = COLOR_FIELDS.some((f) => colors[f.key] !== savedColors[f.key]);
  const dirty = logoDirty || colorsDirty;

  async function save() {
    setSaving(true); setError("");
    try {
      // Logo goes through the edge fn (sets logo_url + derives the email PNG).
      if (logoDirty) {
        const url = logoUrl.trim() || null;
        const { data, error: e } = await supabase.functions.invoke("update-org-logo", {
          body: { organization_id: org.id, logo_url: url },
        });
        if (e) throw e;
        if (data?.error) throw new Error(data.error);
      }
      // Colors go straight to org_branding (only when changed, so untouched
      // defaults are never written).
      if (colorsDirty) {
        const { error: e } = await supabase.from("org_branding").upsert({
          organization_id: org.id,
          primary_color: colors.primary,
          secondary_color: colors.secondary,
          accent_color: colors.accent,
          page_bg_color: colors.pageBg,
          updated_at: new Date().toISOString(),
        }, { onConflict: "organization_id" });
        if (e) throw e;
      }
      flash("Branding saved.");
      setSavedLogo(logoUrl); setSavedColors(colors);
    } catch (e) {
      setError(e.message ?? "Couldn't save your branding.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "8px 0 40px" }}>
      <Link to="/admin/settings" style={{ fontSize: 13, color: MUTED, textDecoration: "none" }}>← Settings</Link>
      <h1 style={{ margin: "8px 0 4px", color: PURPLE, fontSize: 24, fontWeight: 700 }}>Branding</h1>
      <p style={{ color: MUTED, fontSize: 14, marginTop: 0, lineHeight: 1.5, maxWidth: 560 }}>
        Your logo and colors — used on your registration page and every email you send. Set them once here.
      </p>

      {error && <div style={{ marginTop: 16, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}
      {toast && <div style={{ marginTop: 16, padding: "10px 12px", background: GREEN_BG, border: "1px solid #bbf7d0", borderRadius: 8, color: GREEN_INK, fontSize: 13 }}>{toast}</div>}

      {/* Logo */}
      <div style={{ marginTop: 20, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginBottom: 14 }}>Logo</div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ width: 160, height: 90, borderRadius: 8, border: `1px ${logoUrl ? "solid" : "dashed"} ${RULE}`, display: "flex", alignItems: "center", justifyContent: "center", background: "#faf9ff", overflow: "hidden" }}>
            {logoUrl
              ? <img src={logoUrl} alt="Your logo" style={{ maxWidth: "88%", maxHeight: "80%", objectFit: "contain" }} />
              : <span style={{ color: MUTED, fontSize: 12 }}>No logo yet</span>}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input ref={fileRef} type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" onChange={handleFile} style={{ display: "none" }} />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} style={ghostBtn(uploading)}>
              {uploading ? "Uploading…" : logoUrl ? "Replace logo" : "Upload logo"}
            </button>
            {logoUrl && !uploading && (
              <button type="button" onClick={() => setLogoUrl("")} style={{ ...ghostBtn(false), color: MUTED, borderColor: RULE }}>Remove</button>
            )}
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: MUTED, marginTop: 12, lineHeight: 1.5 }}>
          SVG, PNG, JPG, or WebP, under 2 MB. A transparent PNG or SVG looks best — we'll make an
          email-friendly version automatically.
        </div>
      </div>

      {/* Colors */}
      <div style={{ marginTop: 16, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginBottom: 4 }}>Colors</div>
        <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 14, lineHeight: 1.5 }}>Click a swatch to pick your color.</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 14 }}>
          {COLOR_FIELDS.map((f) => (
            <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
              <input
                type="color"
                value={colors[f.key]}
                onChange={(e) => setColors((c) => ({ ...c, [f.key]: e.target.value }))}
                style={{ width: 38, height: 38, border: `1px solid ${RULE}`, borderRadius: 8, padding: 0, background: "none", cursor: "pointer", flexShrink: 0 }}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>{f.label}</div>
                <div style={{ fontSize: 11.5, color: MUTED, lineHeight: 1.4 }}>{f.help}</div>
              </div>
            </label>
          ))}
        </div>

        {/* Live preview using the chosen colors */}
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Preview</div>
          <div style={{ background: colors.pageBg, border: `1px solid ${RULE}`, borderRadius: 8, padding: 20, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ color: colors.primary, fontWeight: 700, fontSize: 16 }}>Your heading</span>
            <button type="button" style={{ background: colors.primary, color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "default" }}>Register</button>
            <span style={{ background: colors.accent, color: "#fff", borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 600 }}>Accent</span>
            <a href="#" onClick={(e) => e.preventDefault()} style={{ color: colors.secondary, fontSize: 13, fontWeight: 600 }}>a link</a>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
        <button type="button" onClick={save} disabled={saving || !dirty} style={primaryBtn(saving || !dirty)}>{saving ? "Saving…" : dirty ? "Save" : "Saved ✓"}</button>
      </div>
    </div>
  );
}

function primaryBtn(disabled) { return { padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
function ghostBtn(disabled) { return { padding: "9px 14px", background: "#fff", color: BRIGHT, border: `1.5px solid ${BRIGHT}`, borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
