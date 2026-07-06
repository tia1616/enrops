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

function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("").toUpperCase();
}

// Pull a small brand palette from an uploaded logo — draw it to a tiny canvas,
// keep the saturated non-background pixels, return the most common distinct
// colors. Runs entirely client-side; returns null on any failure (extraction is
// a nicety, never a blocker). The file is a same-origin blob so getImageData
// isn't tainted; SVGs rasterize to the canvas the same way.
async function extractLogoPalette(file) {
  try {
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const S = 64;
    const canvas = document.createElement("canvas");
    canvas.width = S; canvas.height = S;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, S, S);
    URL.revokeObjectURL(url);
    const { data } = ctx.getImageData(0, 0, S, S);
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 128) continue;                          // transparent
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (sat < 0.18) continue;                        // near-grey (bg/black/white)
      if (lum > 244 || lum < 12) continue;             // too light/dark
      const key = `${r >> 4}|${g >> 4}|${b >> 4}`;     // quantize into buckets
      const cur = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      cur.n++; cur.r += r; cur.g += g; cur.b += b;
      buckets.set(key, cur);
    }
    const sorted = [...buckets.values()]
      .map((c) => ({ n: c.n, r: Math.round(c.r / c.n), g: Math.round(c.g / c.n), b: Math.round(c.b / c.n) }))
      .sort((a, b) => b.n - a.n);
    if (!sorted.length) return null;
    const dist = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
    const picked = [];
    for (const c of sorted) {
      if (picked.every((p) => dist(p, c) > 60)) picked.push(c);
      if (picked.length >= 3) break;
    }
    return {
      primary: picked[0] ? rgbToHex(picked[0].r, picked[0].g, picked[0].b) : null,
      secondary: picked[1] ? rgbToHex(picked[1].r, picked[1].g, picked[1].b) : null,
      accent: picked[2] ? rgbToHex(picked[2].r, picked[2].g, picked[2].b) : null,
    };
  } catch { return null; }
}

export default function BrandLogoSettings() {
  const { org } = useOutletContext();
  const [logoUrl, setLogoUrl] = useState("");
  const [savedLogo, setSavedLogo] = useState("");
  const [colors, setColors] = useState(DEFAULTS);
  const [savedColors, setSavedColors] = useState(DEFAULTS);
  const [suggested, setSuggested] = useState(null); // palette found in the logo, offered (not auto-applied)
  const [bannerUrl, setBannerUrl] = useState("");
  const [savedBanner, setSavedBanner] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const fileRef = useRef(null);
  const bannerRef = useRef(null);

  function flash(msg) { setToast(msg); setTimeout(() => setToast(""), 3000); }

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data: o } = await supabase
        .from("organizations").select("logo_url, logo_email_url").eq("id", org.id).maybeSingle();
      const { data: b } = await supabase
        .from("org_branding").select("primary_color, secondary_color, accent_color, page_bg_color, banner_image_url")
        .eq("organization_id", org.id).maybeSingle();
      if (!cancelled) {
        const url = o?.logo_url || o?.logo_email_url || "";
        const c = {
          primary: b?.primary_color || DEFAULTS.primary,
          secondary: b?.secondary_color || DEFAULTS.secondary,
          accent: b?.accent_color || DEFAULTS.accent,
          pageBg: b?.page_bg_color || DEFAULTS.pageBg,
        };
        const banner = b?.banner_image_url || "";
        setLogoUrl(url); setSavedLogo(url);
        setColors(c); setSavedColors(c);
        setBannerUrl(banner); setSavedBanner(banner);
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
      // Offer colors found in the logo as a SUGGESTION — never auto-apply. Logo
      // pixel-frequency is an unreliable guess (a colorful icon outweighs the
      // brand-color text), so the operator decides whether to use them.
      const palette = await extractLogoPalette(file);
      setSuggested(palette && (palette.primary || palette.secondary || palette.accent) ? palette : null);
    } catch (err) {
      setError(err.message ?? "Couldn't upload that image.");
    } finally {
      setUploading(false);
    }
  }

  async function handleBanner(e) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = "";
    if (!file) return;
    setError("");
    // Banner is a photo shown on the public page (not in email) — raster only.
    const OK = ["image/png", "image/jpeg", "image/webp"];
    if (!OK.includes(file.type)) { setError("Please choose a PNG, JPG, or WebP for the banner."); return; }
    if (file.size > 3_000_000) { setError("That banner is over 3 MB. Please use a smaller file."); return; }
    setUploadingBanner(true);
    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
      const path = `${org.id}/banner/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("org-assets").upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from("org-assets").getPublicUrl(path);
      if (!pub?.publicUrl) throw new Error("Couldn't get the image URL.");
      setBannerUrl(pub.publicUrl);
    } catch (err) {
      setError(err.message ?? "Couldn't upload that banner.");
    } finally {
      setUploadingBanner(false);
    }
  }

  const logoDirty = logoUrl !== savedLogo;
  const colorsDirty = COLOR_FIELDS.some((f) => colors[f.key] !== savedColors[f.key]);
  const bannerDirty = bannerUrl !== savedBanner;
  const dirty = logoDirty || colorsDirty || bannerDirty;

  // Apply the logo-suggested colors into the pickers (operator's explicit click).
  function applySuggested() {
    if (!suggested) return;
    setColors((prev) => ({
      ...prev,
      primary: suggested.primary || prev.primary,
      secondary: suggested.secondary || prev.secondary,
      accent: suggested.accent || prev.accent,
    }));
    setSuggested(null);
  }

  async function save() {
    setSaving(true); setError("");
    try {
      // Logo goes through the edge fn (sets logo_url + derives the email PNG).
      if (logoDirty) {
        const url = logoUrl.trim() || null;
        // Edge functions can return a transient 5xx on a cold-start. Retry ONCE
        // on a transient failure; for a real error (e.g. 403) surface the
        // function's own message and don't retry.
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          const { data, error: e } = await supabase.functions.invoke("update-org-logo", {
            body: { organization_id: org.id, logo_url: url },
          });
          if (!e && !data?.error) { lastErr = null; break; }
          const status = e?.context?.status;
          // invoke() gives a generic "non-2xx" message; read the real error body.
          let msg = data?.error || "";
          if (!msg && e?.context?.clone) { try { msg = (await e.context.clone().json())?.error || ""; } catch { /* body not JSON */ } }
          // Transient only when there's a real error object with a missing/5xx
          // status (cold-start 5xx or network/relay). A 200-with-error-body is a
          // real app error → surface its message, don't retry.
          const transient = !!e && (!status || status >= 500);
          lastErr = { message: msg, transient };
          if (attempt === 0 && transient) { await new Promise((r) => setTimeout(r, 800)); continue; }
          break; // real error → don't retry
        }
        if (lastErr) throw lastErr;
      }
      // Colors + banner go straight to org_branding. Build the payload from only
      // what changed so untouched fields (e.g. default colors) are never written.
      if (colorsDirty || bannerDirty) {
        const payload = { organization_id: org.id, updated_at: new Date().toISOString() };
        // Only write colors the operator ACTUALLY changed. Writing all four would
        // pin untouched fields (still showing the platform default in the picker)
        // to that default value in the DB, detaching them from the fallback.
        COLOR_FIELDS.forEach((f) => { if (colors[f.key] !== savedColors[f.key]) payload[f.col] = colors[f.key]; });
        if (bannerDirty) payload.banner_image_url = bannerUrl.trim() || null;
        const { error: e } = await supabase.from("org_branding").upsert(payload, { onConflict: "organization_id" });
        if (e) throw e;
      }
      flash("Branding saved.");
      setSavedLogo(logoUrl); setSavedColors(colors); setSavedBanner(bannerUrl);
    } catch (e) {
      const raw = e?.message ?? "";
      const jargon = /non-2xx|edge function|failed to fetch|network|fetcherror/i.test(raw);
      // Transient failure or opaque jargon → ask to retry; a real error with a
      // clean message → show it. Never surface runtime jargon to the operator.
      const friendly = e?.transient || jargon
        ? "Couldn't save just now — please click Save again."
        : (raw || "Couldn't save your branding — please try again.");
      setError(friendly);
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
              <button type="button" onClick={() => { setLogoUrl(""); setSuggested(null); }} style={{ ...ghostBtn(false), color: MUTED, borderColor: RULE }}>Remove</button>
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
        <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 14, lineHeight: 1.5 }}>Pick your brand colors, or upload a logo above for suggestions.</div>
        {suggested && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: "#faf9ff", border: `1px solid ${RULE}`, borderRadius: 8, padding: "10px 12px", marginBottom: 14 }}>
            <span style={{ fontSize: 12.5, color: INK, fontWeight: 600 }}>Found in your logo:</span>
            {[suggested.primary, suggested.secondary, suggested.accent].filter(Boolean).map((hex) => (
              <span key={hex} title={hex} style={{ width: 22, height: 22, borderRadius: 5, background: hex, border: `1px solid ${RULE}` }} />
            ))}
            <button type="button" onClick={applySuggested} style={{ ...ghostBtn(false), padding: "6px 12px", marginLeft: 4 }}>Use these</button>
            <button type="button" onClick={() => setSuggested(null)} style={{ ...ghostBtn(false), padding: "6px 12px", color: MUTED, borderColor: RULE }}>Dismiss</button>
          </div>
        )}
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

      {/* Banner */}
      <div style={{ marginTop: 16, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginBottom: 4 }}>Banner</div>
        <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 14, lineHeight: 1.5 }}>A wide photo shown across the top of your registration page. Optional.</div>
        <div style={{ width: "100%", maxWidth: 480, aspectRatio: "16 / 5", borderRadius: 8, border: `1px ${bannerUrl ? "solid" : "dashed"} ${RULE}`, display: "flex", alignItems: "center", justifyContent: "center", background: "#faf9ff", overflow: "hidden" }}>
          {bannerUrl
            ? <img src={bannerUrl} alt="Your banner" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            : <span style={{ color: MUTED, fontSize: 12 }}>No banner yet</span>}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          <input ref={bannerRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleBanner} style={{ display: "none" }} />
          <button type="button" onClick={() => bannerRef.current?.click()} disabled={uploadingBanner} style={ghostBtn(uploadingBanner)}>
            {uploadingBanner ? "Uploading…" : bannerUrl ? "Replace banner" : "Upload banner"}
          </button>
          {bannerUrl && !uploadingBanner && (
            <button type="button" onClick={() => setBannerUrl("")} style={{ ...ghostBtn(false), color: MUTED, borderColor: RULE }}>Remove</button>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: MUTED, marginTop: 12, lineHeight: 1.5 }}>PNG, JPG, or WebP, under 3 MB. A wide image (about 3:1) works best.</div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
        <button type="button" onClick={save} disabled={saving || !dirty} style={primaryBtn(saving || !dirty)}>{saving ? "Saving…" : dirty ? "Save" : "Saved ✓"}</button>
      </div>
    </div>
  );
}

function primaryBtn(disabled) { return { padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
function ghostBtn(disabled) { return { padding: "9px 14px", background: "#fff", color: BRIGHT, border: `1.5px solid ${BRIGHT}`, borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
